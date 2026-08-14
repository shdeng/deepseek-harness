# DeepSeek Harness Desktop PoC

English | [中文](README.zh.md)

This application is an executable Tauri proof of concept for the proposed DeepSeek Harness desktop shell. It starts the real built `dsh web` Host as an owned Node.js child process, waits for the Host to publish an ephemeral loopback URL, and navigates the Tauri WebView to the existing Web client. The shell therefore exercises the current Host composition, dynamic client bundles, unary RPC, and WebSocket downlink without copying product logic into Rust.

The PoC deliberately uses HTTP on `127.0.0.1` so it can validate the shell and existing application end to end before the desktop IPC carrier exists. Loopback HTTP is not the proposed production transport. The [desktop shell Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md) defines the no-listening-socket target.

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

- Rust creates the Node Host inside a Unix process group or Windows Job Object before it can spawn descendants. Tauri exit closes the supervised stdin pipe, waits for the Host to dispose its Cordis tree, then force-terminates and reaps the complete process tree if the configured grace expires.
- Windows release builds carry a fixed Node executable and a production `pnpm deploy` closure. The shell selects these resources before the development `PATH` and repository fallbacks.
- The Host binds to `127.0.0.1` on an operating-system-assigned port. The WebView navigation fence accepts only the exact port published by that child.
- The existing Web application runs unchanged after navigation.
- The loading page exposes a Rust-backed directory picker as a narrow native-operation probe. It is not connected to product filesystem flows.
- Tests cover URL validation, the navigation fence, graceful profile disposal through supervised stdin EOF, and forced cleanup of a stubborn descendant.

## Deliberate limitations

The v0.1 Windows artifacts are an unsigned developer preview. They bundle Node.js and the built JavaScript graph, but do not replace HTTP/WebSocket with Tauri IPC. The supervised stdin EOF request proves graceful lifecycle integration but is not the planned framed sidecar protocol. The native directory picker demonstrates the call path only; production filesystem selection must return through a Host capability and its permission policy rather than granting the Web client general native access.
