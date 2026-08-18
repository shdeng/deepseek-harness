# @deepseek-ai/dsh-game-2048

[English](README.md) | 中文

这个可选 Provider 向 `ctx.games` 注册一个离线 2048 游戏。它的 HTML、CSS 与 JavaScript 完全自包含，并共同形成一个内容摘要寻址的游戏版本。

```yaml
- id: games
  name: '@deepseek-ai/dsh-game'

- id: game-2048
  name: '@deepseek-ai/dsh-game-2048'
```

游戏支持方向键与 W/A/S/D，会播报分数和状态变化，提供清晰的键盘焦点，并在 Desktop Host 标记为隐藏或需要注意时阻止移动。当前棋盘、分数和最佳分数保存在隔离来源的 local storage 中。存档损坏或存储不可用时会开始新游戏，不会阻止游玩。

## Model Experience

None, as 2048 runs only in the isolated human-facing game WebView.

#### KV Cache effect

无；Provider 不贡献提示词、工具、消息或模型请求。

## Known Limitations and Deferred Work

- **一个本地存档** —— 清理 WebView 存储会删除棋盘与最佳分数；存档不会在不同安装之间漫游。
- **键盘优先输入** —— 首个 Provider 支持键盘和按钮交互，但不支持触摸滑动手势。
