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

The shell accepts these development overrides:

| Variable | Meaning | Default |
|---|---|---|
| `DSH_DESKTOP_NODE` | Node.js executable used for the Host | `node` from `PATH` |
| `DSH_DESKTOP_CLI` | Built `dsh` CLI entry | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host working directory, including profile and settings resolution | Shell launch directory |

## Implemented slice

- Rust owns the Node child process, captures its output, detects unexpected exit, and kills and reaps the direct child when Tauri exits.
- The Host binds to `127.0.0.1` on an operating-system-assigned port. The WebView navigation fence accepts only the exact port published by that child.
- The existing Web application runs unchanged after navigation.
- The loading page exposes a Rust-backed directory picker as a narrow native-operation probe. It is not connected to product filesystem flows.
- Unit tests cover URL validation and the navigation fence.

## Deliberate limitations

This is not a distributable desktop release. It does not bundle Node.js or the built JavaScript graph, replace HTTP/WebSocket with Tauri IPC, implement a graceful Host shutdown handshake, or own the complete descendant process tree. The native directory picker demonstrates the call path only; production filesystem selection must return through a Host capability and its permission policy rather than granting the Web client general native access.
