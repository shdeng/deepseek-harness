# `@deepseek-ai/dsh-desktop-app`

English | [中文](README.zh.md)

Desktop-only profile layer applied after `dsh-gui-app`. It selects native Host providers needed by the Tauri deployment and intentionally contains no Web server, HTTP route, WebSocket, frontend-static, or HMR row. Application assets and dynamic client bundles travel through Tauri application/custom protocols; product RPC travels through the private Rust–Node protocol.

## Model Experience

None, as this Desktop patch carrier selects a native GUI provider and registers no model-facing content.

#### KV Cache effect

None; the selected provider does not assemble or send model requests.

## Known Limitations and Deferred Work

- The directory picker still uses the Node native provider. Moving the provider implementation behind the Rust shell remains separate native-capability work.
