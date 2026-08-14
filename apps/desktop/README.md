# DeepSeek Harness Desktop PoC

English | [中文](README.zh.md)

This application is an executable Tauri proof of concept for the proposed DeepSeek Harness desktop shell. It starts the real built `dsh web` Host as an owned Node.js child process, establishes a private framed-stdio protocol, and navigates the Tauri WebView only after both the protocol and an ephemeral loopback asset URL are ready. The existing Web client keeps its product logic while API traffic crosses WebView → Rust → Node through Tauri IPC.

The PoC still uses HTTP on `127.0.0.1` for the application entry and dynamic client bundles. Unary calls, generic RPC, client responses, and the two downstream event streams use the desktop IPC carrier; the Web HTTP/WebSocket carrier remains mounted as a comparison path. The [desktop shell Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md) defines the remaining custom asset protocol and no-listening-socket target.

## Run

Install workspace dependencies once, then start the PoC:

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

Build the Windows portable payload and installers with the bundled Node runtime and production Host dependency closure:

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run release:windows
```

The generated NSIS installer is under `apps/desktop/src-tauri/target/release/bundle/nsis/`. A portable directory consists of `dsh-desktop-poc.exe` plus the generated `release-resources/host` and `release-resources/runtime` directories beside it.

The shell accepts these development overrides:

| Variable | Meaning | Default |
|---|---|---|
| `DSH_DESKTOP_NODE` | Node.js executable used for the Host | `node` from `PATH` |
| `DSH_DESKTOP_CLI` | Built `dsh` CLI entry | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host working directory, including profile and settings resolution | Shell launch directory |
| `DSH_DESKTOP_SHUTDOWN_GRACE_MS` | Grace between the Host shutdown request and forced process-tree termination (1–60000 ms) | `7000` |

## Implemented slice

- Rust creates the Node Host inside a Unix process group or Windows Job Object before it can spawn descendants. Tauri exit sends a framed shutdown request, waits for the Host to dispose its Cordis tree, then force-terminates and reaps the complete process tree if the configured grace expires. Stdin EOF remains the fallback when the protocol pipe fails.
- The versioned `DSH-IPC/1` line frames carry ready, shutdown, fetch-shaped request/response, stream, cancellation, and fatal-error messages. Rust validates transport fields, correlates pending calls, targets stream events to the owning window, rejects late cancelled responses safely, and cancels a window's streams when it closes.
- The client Connection plugin selects `DesktopApiClient` only in a shell-marked WebView. Tauri commands carry unary, respond, and generic RPC traffic; targeted Tauri events carry `events.mux` and `events.host`. The Node adapter dispatches through the same in-process Connection Fetch handlers as the HTTP adapter.
- The Tauri application manifest generates permissions for the three application commands, and the main-window capability grants them only to local application content and the navigation-fenced `127.0.0.1` Web UI.
- Active requests and client stream queues have fixed safety bounds, and Node stdout writes wait for drain before producing more stream frames.
- Windows release builds carry a fixed Node executable and a production `pnpm deploy` closure. The shell selects these resources before the development `PATH` and repository fallbacks.
- The Host binds to `127.0.0.1` on an operating-system-assigned port. The WebView navigation fence accepts only the exact port published by that child.
- The existing Web application and client plugin graph run after navigation; only the Connection carrier selection is desktop-specific.
- The loading page exposes a Rust-backed directory picker as a narrow native-operation probe. It is not connected to product filesystem flows.
- Tests cover private-frame validation, carrier selection and dispatch, URL and navigation validation, graceful profile disposal, late cancellation bookkeeping, and forced cleanup of a stubborn descendant.

## Deliberate limitations

The v0.1 Windows artifacts are an unsigned developer preview. The loopback Web server still serves the application entry and dynamic client bundles, so the build still opens a listening socket and retains the Web carrier as a fallback. The next transport step is a Tauri custom protocol for the Host-authored boot manifest and bundle bytes, followed by a desktop release composition without `dsh-host-webserver`. The native directory picker demonstrates the call path only; production filesystem selection must return through a Host capability and its permission policy rather than granting the Web client general native access.
