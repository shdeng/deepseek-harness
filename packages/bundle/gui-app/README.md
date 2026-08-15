# `@deepseek-ai/dsh-gui-app`

English | [中文](README.zh.md)

Shared graphical application composition. Its patch adds the transport-neutral Host services, client-module registry, Connection service, client-plugin roster, and per-session agent-preset layout used by both Web and Desktop. It opens no listening socket. `dsh-web-app` adds HTTP/WebSocket carriage; `dsh-desktop-app` adds the Desktop-native provider selection.

## Model Experience

Indirectly, through the Host rows and agent presets inserted by this shared graphical patch carrier.

#### KV Cache effect

The bundle adds no text of its own; cache behavior belongs to the inserted rows and selected preset.

## Known Limitations and Deferred Work

- Client packages still declare `platform: web`; the value currently means the shared WebView client runtime and will be renamed separately.
