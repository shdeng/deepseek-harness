# @deepseek-ai/dsh-bilibili-companion

English | [中文](README.zh.md)

Opt-in Tauri-native Bilibili playback synchronized with aggregate live-agent activity. The plugin sends only `{ url, active }` intent through `ctx.desktopNative`: any `running` agent makes Rust show, focus, and play the isolated companion WebView; complete idleness pauses and hides it. The Desktop release includes the package for profile composition but does not mount the local presentation integration by default. It observes public `agent/status` events and does not modify `agent-loop`. Decision record: [the Bilibili companion Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-bilibili-agent-activity-companion.md).

## Config

```yaml
- id: bilibili-companion
  name: '@deepseek-ai/dsh-bilibili-companion'
  config:
    videoUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7'
    nativeTimeoutMs: 5000
```

`videoUrl` defaults to the official Rick Astley MV shown above. It must be credential-free HTTPS on `bilibili.com`, one of its subdomains, or `b23.tv`. `nativeTimeoutMs` is a positive safe-integer bound for each Node-to-Rust reconciliation request.

The package requires `ctx.desktopNative` and therefore activates only in the Tauri Desktop profile. It has no Chromium executable, debugging port, browser profile, or subprocess configuration.

## Native window behavior

Rust owns the `bilibili-companion` WebView window. It creates the window hidden on the first reconciliation, preserves operator-selected Bilibili navigation across later activity changes, and recreates the configured URL after the operator closes the window. A changed `videoUrl` navigates the existing window once; ordinary in-window selection remains untouched.

The window accepts top-level navigation only to credential-free Bilibili HTTPS URLs (plus inert `about:blank` bootstrap), denies downloads, and redirects allowed `window.open` requests back into the same WebView. Its label is absent from the main-window Tauri capability, so remote Bilibili content receives no Harness IPC commands or event permissions. Rust injects only a fixed play/pause helper and never accepts arbitrary JavaScript from Node.

Multiple sessions share one window: the first running agent activates it and the last running agent returning to idle hides it. Native failures are logged without failing an agent turn; a failed desired state is retried after aggregate activity changes. Plugin disposal issues one bounded pause-and-hide request.

## Model Experience

None, as this Host-only media companion registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **Desktop only** — Web and headless profiles have no `ctx.desktopNative` provider and cannot mount this package.
- **Bilibili navigation only** — non-Bilibili top-level links, popups, and downloads are denied rather than opened elsewhere.
- **Site-owned player DOM** — Bilibili DOM changes, login gates, region restrictions, CAPTCHA, or removed videos can prevent fixed play/pause injection from finding a `<video>`.
- **Whole-agent activity** — `running` includes tool execution and any in-turn wait; only the transition back to `idle` pauses and hides the window.
