# @deepseek-ai/dsh-game-companion

[English](README.md) | 中文

这个可选的 Desktop-only Consumer 把一个隔离 Tauri 游戏窗口与所有存活 Agent 的汇总活动同步。它观察公开的 `agent/status`、`agent/disposed`、`approval/request` 与 `games/change` 事件；不会修改 `agent-loop` 或 Session 历史。

## 配置

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

`mode` 是互斥 companion 设置，可取 `off`、`bilibili` 或 `game`。Desktop profile 会挂载注册表、2048 Provider 与 companion，并配置为 `mode: off`。“设置 → 插件配置”会写入 `companion` settings namespace 并即时切换；profile 值仍是恢复默认时继承的基础层。`gameId` 必须是小写 kebab-case，`videoUrl` 必须是不含凭据的 B 站 HTTPS，`nativeTimeoutMs` 限制每次 Node 到 Rust 请求的时长。

## 活动行为

在 `game` 模式下，第一个运行中的 Agent 会让选定游戏进入可玩状态；最后一个离开活动状态后显示完成遮罩。在 `bilibili` 模式下，汇总活动会播放或隐藏配置页面。待处理审批会暂停任一 companion。`off` 让两个原生窗口都保持未激活，插件释放时会隐藏二者。

Rust 持有窗口创建、聚焦、导航、可见性和清理。窗口只接受选定的内容摘要寻址 `dsh-game` 来源，拒绝下载和新窗口，也不属于任何 Tauri capability。关闭窗口会让主 Harness 窗口重新获得焦点；下一个运行区间会从选定 Provider URL 重建窗口。

## Model Experience

None, as this Host presentation plugin never registers model-facing context or operations.

#### KV Cache effect

无；活动与游戏状态从不进入模型输入。

## Known Limitations and Deferred Work

- **仅限 Desktop** —— Web 与 headless profile 不提供 `ctx.desktopNative`，因此不能挂载这个 Consumer。
- **用户问题等待** —— `userQuestions` 没有可供展示观察者使用的实时 pending 事件；`ask_user_question` 等待期间仍可游玩，直到 Agent 回到 idle，而审批等待会立即暂停。
- **一个共享窗口** —— 所有存活根 Agent 共用选定游戏；不支持每 Session 独立游戏或多个 Provider 窗口同时运行。
