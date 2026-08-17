# @deepseek-ai/dsh-bilibili-companion

[English](README.md) | 中文

这是一个按所有存活 agent（智能体）的汇总活动状态同步播放的可选 Tauri 原生 B 站插件。插件只通过 `ctx.desktopNative` 发送 `{ url, active }` 意图：任一 agent 进入 `running` 时，Rust 显示、置前并播放隔离的伴随 WebView；全部 agent 恢复空闲时则暂停并隐藏。Desktop release 会携带本包以供 profile 组合，但不会默认挂载这项本地展示集成。它观察公开的 `agent/status` 事件，不修改 `agent-loop`。决策记录见 [B 站伴随播放 Agent Note](../../../.agents/notes/implemented/feature/2026-08-17-bilibili-agent-activity-companion.md)。

## 配置

```yaml
- id: bilibili-companion
  name: '@deepseek-ai/dsh-bilibili-companion'
  config:
    videoUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7'
    nativeTimeoutMs: 5000
```

`videoUrl` 默认使用上面展示的 Rick Astley 官方 MV。它必须是 `bilibili.com`、其子域名或 `b23.tv` 上不含凭据的 HTTPS URL。`nativeTimeoutMs` 必须是正安全整数，用于限制每次 Node 到 Rust 的状态协调请求。

本包依赖 `ctx.desktopNative`，因此只会在 Tauri Desktop profile 中激活。它不再配置 Chromium 可执行文件、调试端口、浏览器 profile 或子进程。

## 原生窗口行为

Rust 持有 `bilibili-companion` WebView 窗口。第一次协调时以隐藏状态创建窗口，后续活动变化会保留操作者在 B 站内选择的内容；操作者关闭窗口后，下一次协调会使用配置 URL 重建。`videoUrl` 发生变化时，既有窗口只导航一次；普通窗口内选片不会被覆盖。

窗口只接受不含凭据的 B 站 HTTPS 顶层导航（以及无副作用的 `about:blank` 启动页），拒绝下载，并把允许的 `window.open` 请求重定向回同一 WebView。该窗口标签不在主窗口 Tauri capability 中，因此远程 B 站内容不具备任何 Harness IPC command 或 event 权限。Rust 只注入固定的播放／暂停辅助函数，绝不接受 Node 发送的任意 JavaScript。

多个会话共用一个窗口：第一个开始运行的 agent 激活窗口，最后一个运行中的 agent 回到空闲后才隐藏。原生操作失败会被记录，但不会让 agent 轮次失败；活动汇总状态再次变化后会重试此前失败的期望状态。插件 dispose（资源释放）时会发出一次有界的暂停并隐藏请求。

## 模型体验

无，因为这个仅限 Host 的媒体伴随插件不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **仅限 Desktop** —— Web 与 headless profile 没有 `ctx.desktopNative` provider，不能挂载本包。
- **只允许 B 站导航** —— 非 B 站顶层链接、弹窗和下载会被拒绝，而不是转交其他应用打开。
- **播放器 DOM 由站点持有** —— B 站 DOM 变化、登录限制、地区限制、验证码或视频下架都可能让固定播放／暂停注入找不到 `<video>`。
- **整个 agent 活动期间** —— `running` 包括工具执行和轮次内等待；只有回到 `idle` 才会暂停并隐藏窗口。
