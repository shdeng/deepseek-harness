# DeepSeek Harness Desktop

English | [中文](README.zh.md)

This application is the Tauri desktop assembly for DeepSeek Harness. It starts the dedicated `desktop` profile as an owned Node.js Host process, loads the packaged Web client from Tauri's application origin, and carries product traffic through WebView → Rust → Node IPC. The existing Cordis Host, sessions, tools, profiles, and client plugins remain authoritative; Rust owns the window, process tree, packaged runtime, lifecycle, update prompt, and custom client-asset protocol.

Release Desktop composition opens no application listening socket. The Host sends its boot manifest in the `DSH-IPC/1` ready frame; manifest URLs contain opaque `dsh-plugin://` identifiers, and Rust resolves each requested bundle through the private sidecar protocol without exposing a filesystem path. Unary calls, generic RPC, client responses, and both downstream event streams use the same desktop carrier. See the [desktop shell Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md).

## Run

Install workspace dependencies once, then start the application:

```powershell
pnpm install
pnpm desktop:dev
```

`desktop:dev` builds the Host, Web client, and CLI before starting Tauri. When those artifacts are already current, skip the preparation step:

```powershell
pnpm desktop:dev:prepared
```

Run the Rust checks independently:

```powershell
pnpm desktop:check
pnpm desktop:test
```

Build the Windows portable payload and installers with the bundled Node runtime and the Desktop-only production Host dependency closure:

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run release:windows
```

This command uses a Desktop-specific TypeScript and bundle build, then deploys from `@deepseek-ai/dsh-desktop-runtime` instead of the general CLI package. The release composition is DeepSeek-only: the multi-provider pi-ai bundle, OpenAI and Anthropic SDKs, Codex and Claude agent SDKs, and their Harness adapters are outside the build and deploy closures. Release preparation scans every deployed package manifest and fails if any excluded package re-enters transitively. The general `dsh web` and `dsh headless` profiles still include the optional multi-provider bundle.

The generated NSIS installer is under `apps/desktop/src-tauri/target/release/bundle/nsis/`. A portable directory consists of `deepseek-harness-app.exe` plus the generated `release-resources/host` and `release-resources/runtime` directories beside it.

The shell accepts these development overrides:

| Variable | Meaning | Default |
|---|---|---|
| `DSH_DESKTOP_NODE` | Node.js executable used for the Host | `node` from `PATH` |
| `DSH_DESKTOP_CLI` | Built `dsh` CLI entry | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host working directory, including profile and settings resolution | Shell launch directory |
| `DSH_DESKTOP_SHUTDOWN_GRACE_MS` | Grace between the Host shutdown request and forced process-tree termination (1–60000 ms) | `7000` |

## Updates and user data

Release builds check the repository's latest stable GitHub Release once at startup. When its numeric version is newer, a native confirmation dialog offers to open that exact release page in the system browser. The application never downloads, executes, or replaces binaries silently; cancelling the prompt leaves the current version running. Network, response-validation, and browser-opening failures are logged without blocking Host or WebView startup.

Profiles, settings, credential references, attachments, and session history live under `$DSH_HOME` (`~/.dsh` by default), outside both the NSIS installation directory and a portable application's directory. Desktop credential values live in Windows Credential Manager, macOS Keychain, or Linux Secret Service. The update check never writes to either store, and installing a newer application version replaces application files only. Keep a backup before any future release that explicitly announces a user-data migration.

## Implemented slice

- Rust creates the Node Host inside a Unix process group or Windows Job Object before it can spawn descendants. Tauri exit sends a framed shutdown request, waits for the Host to dispose its Cordis tree, then force-terminates and reaps the complete process tree if the configured grace expires. Stdin EOF remains the fallback when the protocol pipe fails.
- The versioned `DSH-IPC/1` line frames carry the boot manifest, opaque client-asset reads, shutdown, fetch-shaped request/response, streams, cancellation, and fatal errors. Rust validates transport fields, maps the canonical `dsh-plugin://localhost` asset URLs to WebView2's `http://dsh-plugin.localhost` custom-protocol origin on Windows, correlates pending calls, targets stream events to the owning window, rejects late cancelled responses safely, and cancels a window's streams when it closes.
- The client Connection plugin selects `DesktopApiClient` only in a shell-marked WebView. Tauri commands carry unary, respond, and generic RPC traffic; targeted Tauri events carry `events.mux` and `events.host`. The Node adapter dispatches through the same in-process Connection Fetch handlers as the HTTP adapter.
- `ctx.desktopNative` is the Service Definition for Rust-owned OS work. The directory-picker Provider, credential Provider, external-link and notification API Consumers, application metadata, isolated media companion, and deep-link Host stream all use its reverse-request/event channel. The main WebView has no direct picker, keychain, notification, opener, metadata, or deep-link plugin permission.
- Desktop credential entry occurs in a native Rust dialog and writes directly to the operating-system vault. WebView and framed stdio carry only `CredentialRef` handles; Node resolves provider credentials through the packaged Rust dynamic library. Desktop carriage rejects plaintext credential writes and model-discovery keys before the Node pipe.
- Rust accepts only credential-free HTTP(S) external URLs and `deepseek-harness://session/<session-id>` deep links. A background running-to-idle transition sends a native notification, and an accepted deep link focuses the main window and selects the addressed session through the Host stream.
- The release includes an opt-in Bilibili companion using a separate remote WebView label with no Tauri capability. Rust admits only credential-free Bilibili HTTPS navigation, denies downloads, redirects allowed popup navigation into the same window, and accepts only `{ url, active }` state from Node.
- The Tauri application manifest generates permissions for its application commands, and the main-window capability grants them only to packaged local content. Release navigation accepts only the Tauri application origin; debug builds also accept the exact development origin injected into Tauri's `devUrl`, while other loopback ports remain rejected. CSP excludes remote scripts and general network access, admits client bundles only from the application-owned protocol, permits `unsafe-eval` because the trusted Cordis client loader and schemastery callback rehydration compile Host-provided code with `new Function`, and permits inline styles because those bundles materialize their scoped CSS at runtime.
- Active requests and client stream queues have fixed safety bounds, and Node stdout writes wait for drain before producing more stream frames.
- Windows release builds carry a fixed Node executable and a DeepSeek-only production `pnpm deploy` closure. A dedicated build entry excludes pi-ai, OpenAI, Anthropic, Codex, and Claude packages before packaging. A deployed-manifest audit rejects excluded packages and missing required internal peers. The shell selects these resources before the development `PATH` and repository fallbacks.
- Release builds validate the latest stable GitHub Release and ask before opening its trusted release page; downloading and installing remain explicit user actions.
- The dedicated Desktop profile composes `dsh-base` + transport-neutral `dsh-gui-app` + `dsh-desktop-app`; `dsh-web-app`, `dsh-host-webserver`, frontend-static serving, and client HMR are forbidden from the release closure.
- The existing Web application and Host-authored client plugin graph run from packaged/custom-protocol assets; only bootstrap and Connection carriage are desktop-specific.
- Tests cover private-frame validation, carrier selection and dispatch, URL and navigation validation, graceful profile disposal, late cancellation bookkeeping, and forced cleanup of a stubborn descendant.

## Deliberate limitations

The v0.4 Windows artifacts remain an unsigned developer preview. Updates are manual after the application opens the GitHub Release page; there is no signed in-app installer, background download, or automatic rollback. macOS/Linux packaging and signing, notification interaction actions, full packaged WebView automation, and broader native filesystem/subprocess providers remain open.
