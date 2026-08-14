# Agent Note: Tauri desktop shell — retain the Node Host and move operating-system ownership into Rust

Status: proposed

English | [中文](2026-08-14-tauri-desktop-shell.zh.md)

## Problem

DeepSeek Harness already has a plugin-composed Node.js Host, a dynamically composed Web client, and a channel-independent four-quadrant RPC model. A desktop application should reuse those product layers while gaining native window, lifecycle, packaging, update, credential, dialog, and process-management behavior.

A full Rust rewrite would replace the mature Cordis plugin runtime, TypeScript service definitions, model-visible session logging, profile loading, and client plugin graph at once. That work has little relationship to desktop integration and would create a second extension system. Conversely, placing the existing Web server in a desktop window leaves a listening socket, weakens process ownership, and does not establish a controlled path for native operations.

We need a desktop architecture that preserves the existing Host and Client responsibilities, makes Rust the owner of operating-system resources, and migrates native work incrementally without letting the WebView bypass Host permissions or session semantics.

## Proposal

Add `apps/desktop` as a Tauri application with two runtimes:

- The Rust shell owns the application window, application lifecycle, packaged runtime discovery, updates, secure credential handles, native dialogs, notifications, deep links, and the Node Host process tree.
- The existing Node.js Host remains the product authority for Cordis composition, sessions, profiles, tools, agent execution, settings, filesystem policy, and client plugin discovery.
- The existing Web client remains the UI. A desktop-specific client carrier subclasses `AbstractApiClient`; it does not fork UI features.

The production topology is:

```text
Tauri WebView
  client plugins and desktop AbstractApiClient carrier
          │ Tauri IPC: unary requests, downlink channels, bundle reads
          ▼
Rust shell
  window + lifecycle + updater + native providers + sidecar supervisor
          │ private framed stdio/local IPC, no listening socket
          ▼
Node Host sidecar
  dsh-host-runtime + ApiProxy + profile/session/tool capability plugins
```

`apps/desktop` is application assembly, not a reusable package. Capability behavior stays in `packages/`; application-only transport and boot wiring stay in the app. This does not change `agent-loop`.

### Process and trust model

The packaged Tauri executable is the process root. It launches the bundled Node runtime with a fixed, application-owned Host entry and passes configuration through an explicit bootstrap message. It must not find an arbitrary `node` or Host script from `PATH` in production. Development overrides remain opt-in and fail loud when their targets do not exist.

Rust creates one ownership domain for the Node process and all descendants: a Job Object on Windows and a process group with parent-death handling on Unix. Shutdown first sends a protocol-level stop request, waits for Host services and session persistence to quiesce, then terminates the ownership domain after a configured deadline. Startup becomes ready only after the Host has loaded its profile, registered API methods, and returned the client boot manifest. Unexpected exit is surfaced as a recoverable shell error with a bounded stderr tail.

The WebView cannot navigate to arbitrary remote content. Application assets use Tauri's application origin; client plugin bundles use an application-owned custom protocol; external links open in the system browser after an allowlist decision. Content Security Policy excludes remote scripts and general network access.

### Desktop RPC carrier

The desktop carrier preserves the existing four-quadrant message definitions and validation. It changes only physical carriage:

| Logical traffic | Desktop carriage |
|---|---|
| Client unary request and Host response | Tauri `invoke` to Rust, framed request to Node, correlated response back to the WebView |
| Host request and Client response | Framed Node message, Rust event/channel to the selected window, correlated client response |
| Host notification | Framed Node message forwarded through a bounded Tauri channel |
| Client notification | Tauri `invoke` with no application response beyond transport acknowledgement |

Rust treats RPC payloads as opaque validated JSON envelopes and routes by request identifier and window identifier. The TypeScript protocol remains the single semantic source of truth. A generated Rust envelope type may own transport fields, but Rust must not duplicate method-specific request or response schemas.

Backpressure and cancellation are protocol behavior, not incidental channel behavior. Each stream has a bounded queue; window closure cancels its subscriptions; Host exit rejects pending calls; shell shutdown stops accepting new calls before requesting Host quiescence. The implementation must prove that late responses, duplicate terminal messages, and a closed WebView cannot retain routes or panic the shell.

### Dynamic client boot and assets

The Host continues to author the client plugin graph and `__DSH_BOOT__` manifest. During startup it returns that manifest over the private sidecar protocol. The shell serves the static application entry and requested plugin bundle bytes through a Tauri custom URI protocol, keyed by opaque bundle identifiers from the manifest. It does not expose arbitrary filesystem paths.

Development HMR may use an explicitly enabled loopback development server. Release builds use only packaged assets and Host-provided plugin bundles. The Web server package is absent from the release desktop composition.

### Native capability providers

Native operations are Host capabilities with Rust-backed providers, not unrestricted JavaScript commands. The direction is:

```text
client intent → existing Host API/tool → Host policy and permission → Rust provider → operating system
```

Initial provider candidates are directory/file selection, secure credential storage, notifications, application metadata, and controlled external-link opening. Filesystem reads and writes remain behind `dsh-fs` policy; a picker returns a selected resource to the Host and does not grant the WebView general path access. Native provider requests carry branded opaque identifiers when they cross the Rust/Node process boundary.

Window-only operations such as minimize or focus may be shell commands when they cannot alter product data, agent inputs, permissions, or durable state. Anything model-visible remains reconstructable from the session log.

### Packaging and updates

The first distributable version bundles a known Node runtime, built application entry, workspace package closure, client assets, and required native modules as Tauri resources or sidecars. It does not use Node Single Executable Applications initially because profiles and plugin resolution require normal module and filesystem semantics. The build gate launches the packaged Host entry with plain bundled Node on every target.

User profiles, sessions, settings, and caches live outside the immutable application bundle in platform application-data directories. Schema and session-format rejection behavior remains owned by the existing Node packages. The Rust updater replaces application artifacts only after the Host has quiesced; rollback never rewrites user data.

### Migration sequence

1. Validate reuse with the loopback PoC in `apps/desktop`: Rust supervises the real built `dsh web` in an operating-system process container, navigates only to the child-published ephemeral port, requests graceful disposal through supervised stdin EOF, and exposes one native dialog probe.
2. Add a private framed Node/Rust protocol and readiness/shutdown handshake while retaining the Web server only as a comparison path.
3. Implement the desktop `AbstractApiClient` carrier and Tauri custom-protocol bundle loader; remove `dsh-host-webserver` from desktop release composition.
4. Add packaged Node and JavaScript resources, application-data resolution, and cross-platform packaged smoke tests for the process-tree ownership established by the PoC.
5. Move selected native providers behind existing or newly completed capability seams. Each seam includes Service Definition, Rust-backed provider bridge, Consumer, unit coverage, assembled e2e coverage, and keyless snapshot coverage when behavior is product- or model-visible.

### PoC evidence and limits

The checked-in PoC implements step 1 and the Windows packaging slice of step 4. It uses the actual built CLI and Web application, parses the exact `dsh web: http://127.0.0.1:<port>/` readiness line, constrains navigation to that port, captures Host diagnostics, and detects unexpected exit. The Rust shell creates a Unix process group or Windows Job Object before the Host can spawn descendants. Shell exit closes the Host's supervised stdin pipe, waits for the CLI's bounded Cordis disposal, then force-terminates and reaps the whole process tree after a configurable outer grace. Windows release builds carry a fixed Node executable and a production `pnpm deploy` closure as Tauri resources; release preparation materializes workspace links so the artifact does not depend on repository paths. The shell normalizes Windows verbatim resource paths before passing the Host entry to Node and selects packaged resources before development fallbacks. Rust tests cover URL rejection, navigation authorization, packaged-resource fallback, cooperative exit, and forced descendant cleanup; a built-CLI e2e test proves stdin EOF reaches profile disposal.

The PoC's loopback HTTP/WebSocket transport, supervised stdin control channel, Windows-only unsigned packaging, and loading-page directory picker are evidence, not production decisions. Stdin EOF proves lifecycle integration but does not replace the planned framed sidecar shutdown request, and the picker does not yet pass through Host filesystem policy.

## Alternatives considered

- Rewrite the Host in Rust. Rejected because desktop integration does not justify replacing Cordis composition, the TypeScript capability seams, durable session behavior, and the existing test corpus.
- Use Electron. Viable for maximum Node integration, but it provides less isolation between shell and Host and a larger bundled browser/runtime surface. Tauri better matches the desired thin native owner while allowing the Web client to remain unchanged.
- Keep loopback HTTP and WebSocket in production. Rejected because the desktop application does not need a network listener and would need additional origin, authentication, port-conflict, firewall, and shutdown behavior.
- Let the WebView call Tauri plugins directly for files, credentials, and processes. Rejected because it bypasses Host permission, capability, logging, and profile composition.
- Compile Node into a single executable immediately. Deferred because dynamic package and profile resolution are first-class behavior; a bundled ordinary Node runtime is easier to validate and update independently.

## Acceptance criteria

- [ ] A release desktop build starts without a system Node installation and without opening a listening socket.
- [ ] The existing Host profile, session, tool, settings, and client plugin composition runs without desktop-specific forks in `agent-loop` or UI feature packages.
- [ ] All four RPC quadrants, cancellation, bounded delivery, window closure, Host crash, and shell shutdown have focused tests over the desktop carrier.
- [ ] The Host remains the authority for filesystem, credential, process, and model-visible operations; Rust providers cannot be reached through a general WebView escape hatch.
- [ ] Windows, macOS, and Linux packaged smokes prove startup readiness, one unary call, one downlink event, one dynamic client bundle load, graceful shutdown, and descendant-process cleanup.
- [ ] Release Content Security Policy and navigation tests reject remote script, arbitrary network, and arbitrary local-file access.
- [ ] Build inputs pin the Node runtime and native dependencies, and packaged-Host smokes run against the produced artifact rather than source.
- [ ] Desktop behavior changes update the affected README/JSDoc, this note or its successor, and keyless snapshots when output is product- or model-visible.

## Risks

- System WebView differences can expose rendering or custom-protocol differences that the browser test matrix does not cover. Packaged smokes and targeted WebView e2e tests must own this signal.
- Native Node modules may require per-target packaging and signing rules. The artifact gate must enumerate and load them from the packaged layout.
- Dynamic bundle loading can drift from Content Security Policy. Bundle identifiers, bytes, and script execution policy need one tested application-origin design.
- Rust and TypeScript carrier implementations can diverge. Generated transport-envelope fixtures and shared transcript tests should verify both sides without duplicating method schemas.
- Descendant processes can outlive the Host if ownership is attached after spawn or bypassed by providers. Process-group/Job Object creation must occur at spawn and teardown tests must inspect the complete tree.
