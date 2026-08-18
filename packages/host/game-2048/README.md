# @deepseek-ai/dsh-game-2048

English | [中文](README.zh.md)

This optional Provider registers an offline 2048 game with `ctx.games`. Its HTML, CSS, and JavaScript are self-contained and become one content-addressed game revision.

```yaml
- id: games
  name: '@deepseek-ai/dsh-game'

- id: game-2048
  name: '@deepseek-ai/dsh-game-2048'
```

The game supports arrow keys and W/A/S/D, announces score and state changes, exposes visible keyboard focus, and blocks movement while the Desktop Host marks it hidden or attention-required. It stores the current board, score, and best score in isolated-origin local storage. A corrupt or unavailable save starts a fresh game without blocking play.

## Model Experience

None, as 2048 runs only in the isolated human-facing game WebView.

#### KV Cache effect

None; the Provider contributes no prompt, tool, message, or model request.

## Known Limitations and Deferred Work

- **One local save** — Resetting WebView storage clears the board and best score; saves do not roam between installations.
- **Keyboard-first input** — The first Provider supports keyboard and button interaction but no touch-swipe gesture.
