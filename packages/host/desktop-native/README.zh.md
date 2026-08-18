# @deepseek-ai/dsh-host-desktop-native

[English](README.md) | 中文

这是由受监督 Rust Desktop 壳层持有的操作系统操作 Service Definition。`ctx.desktopNative` 向 Host Consumer 提供目录选择、原生凭据采集、受控 HTTP(S) 外链打开、系统通知、应用包元数据、隔离的媒体与本地游戏伴随窗口，以及已接受的深链接事件。Node Provider 位于 Desktop CLI 启动过程，通过私有 `DSH-IPC/1` 反向请求通道工作；主 WebView 没有这些操作对应的 Tauri command。

每个请求和响应都会在进程两端校验。深链接格式为 `deepseek-harness://session/<session-id>`，并以 `desktopNative/deep-link` 事件进入 Host；Rust 会在发布事件前拒绝其他 scheme、authority、查询、fragment 以及非 URL-safe 的会话 id。详见[桌面壳 Agent Note](../../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md)。

## 模型体验

间接影响，通过在自身产品操作中使用原生结果的 Host Consumer 产生。

#### KV Cache 影响

无；该服务不组装模型请求。

## 已知限制与暂缓事项

- 当前服务只公开 Desktop profile 已需要的原生操作；文件系统和子进程执行仍留在 Node，并继续受现有策略 seam 约束。
- 媒体操作只接受 B 站 URL 和 active／inactive 意图；任意远程 URL、脚本、窗口标签与通用命令均不属于该接口。
- 游戏操作只接受内容摘要寻址的本地入口 URL 与封闭的 hidden／playable／attention 状态；游戏资产通过单独的有界读取操作传输。
