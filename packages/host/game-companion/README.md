# @deepseek-ai/dsh-game-companion

English | [中文](README.zh.md)

This optional Desktop-only Consumer synchronizes one isolated Tauri game window with aggregate live-Agent activity. It observes public `agent/status`, `agent/disposed`, `approval/request`, and `games/change` events; it does not modify `agent-loop` or Session history.

## Configuration

```yaml
- id: games
  name: '@deepseek-ai/dsh-game'

- id: game-2048
  name: '@deepseek-ai/dsh-game-2048'

- id: game-companion
  name: '@deepseek-ai/dsh-game-companion'
  config:
    mode: 'game'
    gameId: '2048'
    videoUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7'
    nativeTimeoutMs: 5000
```

`mode` is the exclusive companion setting: `off`, `bilibili`, or `game`. The Desktop profile mounts the registry, 2048 Provider, and companion with `mode: off`. The Plugins settings page writes the `companion` settings namespace and switches mode immediately; the profile value remains its reset/default layer. `gameId` must be lowercase kebab-case, `videoUrl` must be credential-free Bilibili HTTPS, and `nativeTimeoutMs` bounds every Node-to-Rust request.

## Activity behavior

In `game` mode, the first running Agent makes the selected game playable; the last one leaving activity pauses behind a completion overlay. In `bilibili` mode, aggregate activity plays or hides the configured page. A pending approval pauses either companion. `off` keeps both native windows inactive, and plugin disposal hides both.

Rust owns window creation, focus, navigation, visibility, and cleanup. The window accepts only the selected content-addressed `dsh-game` origin, denies downloads and new windows, and appears in no Tauri capability. Closing it returns focus to the main Harness window; the next running interval recreates it from the selected Provider URL.

## Model Experience

None, as this Host presentation plugin never registers model-facing context or operations.

#### KV Cache effect

None; activity and game state never enter model input.

## Known Limitations and Deferred Work

- **Desktop only** — Web and headless profiles do not provide `ctx.desktopNative`, so they cannot mount this Consumer.
- **User-question waits** — `userQuestions` has no live pending event for a presentation observer; an `ask_user_question` wait remains playable until the Agent returns idle, while approval waits pause immediately.
- **One shared window** — All live root Agents share the selected game; per-session games and simultaneous Provider windows are unsupported.
