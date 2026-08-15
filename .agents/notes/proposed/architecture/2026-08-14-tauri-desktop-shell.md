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

### Composition boundaries

The graphical composition is split by responsibility instead of by historical entrypoint. `dsh-gui-app` carries the transport-neutral Host services, client-module registry, Connection service, client plugin roster, and per-session agent presets shared by both graphical surfaces. `dsh-web-app` adds the HTTP server, `/api`, WebSocket downlinks, `/plugins`, frontend-static fallback, HMR, browser trust, and Web startup flags. `dsh-desktop-app` selects Desktop-native providers and contains no Web server, static-server, HTTP route, WebSocket, or HMR row. The `web` template composes `base + llm-multi-provider + gui-app + web-app`; the `desktop` template composes `base + gui-app + desktop-app`.

Transport-neutral packages must not invent a network owner. `dsh-client-modules` discovers, hashes, and reads built client assets. The Web bundle maps those reads to `/plugins`; the Rust shell maps them to `dsh-plugin://localhost/<opaque-digest>/client.js`. `dsh-client-connection` always provides the trusted same-process Fetch bridge, while its HTTP and WebSocket adapters activate only when a Web server service exists.

### Process and trust model

The packaged Tauri executable is the process root. It launches the bundled Node runtime with a fixed, application-owned Host entry and passes configuration through an explicit bootstrap message. It must not find an arbitrary `node` or Host script from `PATH` in production. Development overrides remain opt-in and fail loud when their targets do not exist.

Rust creates one ownership domain for the Node process and all descendants: a Job Object on Windows and a process group with parent-death handling on Unix. Shutdown first sends a protocol-level stop request, waits for Host services and session persistence to quiesce, then terminates the ownership domain after a configured deadline. Startup becomes ready only after the Host has loaded its profile, registered API methods, and returned the client boot manifest. Unexpected exit is surfaced as a recoverable shell error with a bounded stderr tail.

The WebView cannot navigate to arbitrary remote content. Application assets use Tauri's application origin; client plugin bundles use an application-owned custom protocol; external links open in the system browser after an allowlist decision. Content Security Policy excludes remote scripts and general network access. It explicitly permits `unsafe-eval` because the Cordis client module evaluator and schemastery callback rehydration execute Host-provided trusted code through `new Function`, and permits inline styles because trusted client bundles materialize their scoped CSS at runtime. These exceptions do not admit a remote script, style, image, or font source and do not weaken the navigation fence.

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

The first distributable version bundles a known Node runtime, built application entry, application-specific workspace package closure, client assets, and required native modules as Tauri resources or sidecars. Desktop release builds select the DeepSeek provider composition at the profile template, TypeScript reference, JavaScript bundle, and production deploy stages. The optional pi-ai bundle and its OpenAI and Anthropic SDK closure, plus Codex and Claude agent adapters, remain available to general CLI profiles but are absent from Desktop release inputs. A manifest audit fails release preparation if an excluded package re-enters transitively or a required internal peer is absent. The application does not use Node Single Executable Applications initially because profiles and plugin resolution require normal module and filesystem semantics. The build gate launches the packaged Host with the bundled Node runtime, observes readiness, requests framed shutdown, and requires clean completion on every target.

User profiles, sessions, settings, credentials, attachments, and caches live under `$DSH_HOME` (`~/.dsh` by default), outside installer and portable application directories. Schema and session-format rejection behavior remains owned by the existing Node packages. The initial release checker queries the repository's latest stable GitHub Release once at startup, validates its numeric version and exact repository release URL, and asks before opening that page for a manual download. It does not download, execute, replace, or roll back application artifacts. A future automatic installer requires signed artifacts and must quiesce the Host before replacing application files; neither installation nor rollback may rewrite `$DSH_HOME`.

### Migration sequence

1. Completed in v0.1–v0.2: validate reuse with a loopback PoC, establish process-tree ownership, package a fixed Node runtime and Desktop Host closure, add the framed protocol, and switch product RPC to the Tauri carrier.
2. Completed in v0.3: split graphical composition from Web transport, return the boot manifest over the private protocol, serve dynamic bundles through the application-owned custom protocol, embed the built application entry, and remove the Web server closure from Desktop releases.
3. Completed after v0.3: move directory/file selection behind a complete Host capability seam whose Desktop provider calls Rust, then remove the general picker command from the WebView capability.
4. Completed after v0.3: migrate secure credential storage, controlled external-link opening, notifications, application metadata, and deep links behind the Host-to-Rust private protocol. Filesystem and subprocess execution remain in Node until a separately justified provider can preserve their policy and streaming behavior.
5. Before stable release: add macOS and Linux artifact jobs, signing and notarization, packaged WebView interaction coverage, protocol transcript conformance fixtures, and an update installer design that preserves `$DSH_HOME`.

### v0.3 evidence and limits

The checked-in v0.3 foundation starts `--profile desktop`, waits for a `ready` frame containing the client boot manifest, and never starts `dsh web`. `DSH-IPC/1` line frames carry Fetch-shaped requests and responses, stream frames, cancellation, opaque asset reads, shutdown, and fatal errors over supervised stdio. The Node adapter dispatches product RPC through Connection's trusted same-process Fetch entry. Rust validates transport fields and custom-protocol asset URLs, correlates pending requests, targets stream events to their owning window, bounds active routes, ignores late cancelled responses, and cancels window-owned streams on destruction. The shell-marked WebView selects `DesktopApiClient`; Tauri commands carry unary, respond, and generic RPC traffic, while targeted Tauri events carry both downlink streams with a bounded client inbox.

The Rust shell creates a Unix process group or Windows Job Object before the Host can spawn descendants. Shell exit sends a framed shutdown request, waits for the CLI's bounded Cordis disposal, then force-terminates and reaps the whole process tree after a configurable outer grace; stdin EOF remains the broken-protocol fallback. Windows release builds carry a fixed Node executable and a DeepSeek-only production `pnpm deploy` closure as Tauri resources; release preparation materializes workspace links so the artifact does not depend on repository paths. The release command uses a Desktop-specific compiler and bundler selection rather than the repository-wide build, performs an isolated injected deploy from a dependency-only Desktop runtime root without changing the repository install, rejects excluded package manifests and missing required internal peers, then exercises packaged Host startup and cooperative shutdown. The shell passes Node's explicit loader-internals opt-in required by Cordis config HMR, normalizes Windows verbatim resource paths before passing the Host entry to Node, and selects packaged resources before development fallbacks. Release builds also perform the bounded GitHub check described above; check failures do not block Host or WebView startup, and the check never writes user data. Focused TypeScript and Rust tests cover frame rejection, carrier selection, privileged same-process dispatch without HTTP trust headers, URL and navigation authorization, cancellation bookkeeping, cooperative exit, forced descendant cleanup, release selection, trusted release URLs, and the exact update prompt. Packaged interaction automation for the native update dialog remains open.

The application entry is embedded in the Tauri binary and dynamic bundles use canonical `dsh-plugin://localhost` URLs containing only Host-minted opaque digests. Rust maps those URLs to WebView2's `http://dsh-plugin.localhost` custom-protocol origin on Windows after validation; macOS and Linux retain the canonical scheme. The CSP regression test fixes the narrow dynamic-code exception and rejects remote script schemes; the initialization script displays bootstrap exceptions instead of leaving an empty WebView. Release policy rejects `dsh-web-app`, `dsh-host-webserver`, `dsh-host-frontend-static`, `dsh-web-frontend`, and `dsh-client-hmr` from the Desktop closure. The packaged-Host smoke verifies a ready manifest, no Windows TCP listener owned by the Host, one bundle read, native application metadata, one `host.describe` unary call, and framed cooperative shutdown. The reverse private protocol now carries Host-initiated native requests and Rust-originated deep-link events. `ctx.desktopNative` exposes directory selection, controlled HTTP(S) opening, notification delivery, and application metadata; the Desktop credential provider captures secrets in a Rust dialog, stores them in the platform vault, and resolves them through a same-process Rust library, so WebView and stdio frames carry only credential references. The main-window ACL retains event listening and the three application RPC commands but grants no picker, credential, opener, notification, metadata, or deep-link plugin command. Rust tests additionally cover forced descendant cleanup and the native URL policies. Remaining gaps are an automated packaged WebView interaction smoke, a downlink event exercised in the packaged artifact, non-Windows packaging and signing, notification actions, and any future filesystem or subprocess provider migration.

## Alternatives considered

- Rewrite the Host in Rust. Rejected because desktop integration does not justify replacing Cordis composition, the TypeScript capability seams, durable session behavior, and the existing test corpus.
- Use Electron. Viable for maximum Node integration, but it provides less isolation between shell and Host and a larger bundled browser/runtime surface. Tauri better matches the desired thin native owner while allowing the Web client to remain unchanged.
- Keep loopback HTTP and WebSocket in production. Rejected because the desktop application does not need a network listener and would need additional origin, authentication, port-conflict, firewall, and shutdown behavior.
- Let the WebView call Tauri plugins directly for files, credentials, and processes. Rejected because it bypasses Host permission, capability, logging, and profile composition.
- Compile Node into a single executable immediately. Deferred because dynamic package and profile resolution are first-class behavior; a bundled ordinary Node runtime is easier to validate and update independently.

## Acceptance criteria

- [x] A Windows release desktop build carries its Node runtime and its Host opens no listening socket.
- [x] The existing Host profile, session, tool, settings, and client plugin composition runs without desktop-specific forks in `agent-loop` or UI feature packages.
- [ ] All four RPC quadrants, cancellation, bounded delivery, window closure, Host crash, and shell shutdown have focused tests over the desktop carrier.
- [x] The Host remains the authority for filesystem, credential, process, and model-visible operations; Rust providers cannot be reached through a general WebView escape hatch.
- [ ] Windows, macOS, and Linux packaged smokes prove startup readiness, one unary call, one downlink event, one dynamic client bundle load, graceful shutdown, and descendant-process cleanup.
- [x] Release Content Security Policy and navigation tests reject remote script, arbitrary network, and arbitrary local-file access at the configured shell boundary.
- [x] Windows build inputs pin the Node runtime and packaged-Host smokes run against the produced artifact rather than source.
- [x] Desktop behavior changes update the affected README/JSDoc and this note; v0.3 changes no product- or model-visible transcript.

## Risks

- System WebView differences can expose rendering or custom-protocol differences that the browser test matrix does not cover. Packaged smokes and targeted WebView e2e tests must own this signal.
- Native Node modules may require per-target packaging and signing rules. The artifact gate must enumerate and load them from the packaged layout.
- Dynamic bundle loading can drift from Content Security Policy. Bundle identifiers, bytes, and script execution policy need one tested application-origin design.
- Rust and TypeScript carrier implementations can diverge. Generated transport-envelope fixtures and shared transcript tests should verify both sides without duplicating method schemas.
- Descendant processes can outlive the Host if ownership is attached after spawn or bypassed by providers. Process-group/Job Object creation must occur at spawn and teardown tests must inspect the complete tree.
