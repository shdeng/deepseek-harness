# @deepseek-ai/dsh-host-desktop-native

English | [中文](README.zh.md)

Service Definition for operating-system work owned by the supervised Rust desktop shell. `ctx.desktopNative` exposes directory selection, native credential capture, controlled HTTP(S) link opening, system notifications, application-package metadata, and accepted deep-link events to Host Consumers. The Node Provider lives in the Desktop CLI bootstrap and uses the private `DSH-IPC/1` reverse-request channel; the WebView has no Tauri command for these operations.

Every request and response is validated on both process sides. Deep links use `deepseek-harness://session/<session-id>` and arrive as `desktopNative/deep-link`; Rust rejects other schemes, authorities, queries, fragments, and non-URL-safe session ids before publishing the event. See the [desktop shell Agent Note](../../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md).

## Model Experience

Indirectly, through Host Consumers that use native results in their own product operations.

#### KV Cache effect

None; the service does not assemble model requests.

## Known Limitations and Deferred Work

- The service currently exposes the native operations required by the Desktop profile; filesystem and subprocess execution remain in Node behind their existing policy seams.
