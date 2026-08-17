# Agent Note: 由 agent 活动驱动的 B 站伴随播放

Status: implemented

[English](2026-08-17-bilibili-agent-activity-companion.md) | 中文

## 问题

长时间的 Harness 任务会让操作者等待模型请求和工具执行，但普通浏览器播放与这些工作之间没有可靠关系。复用个人浏览器标签页可能改变无关的登录状态；没有生命周期所有权的窗口则可能在任务结束后继续播放。并发会话也使按单个轮次切换失去正确性：一个会话结束时，另一个会话可能仍在运行。

## 决策

**一个可选 Host 插件驱动一个由 Rust 持有的 Tauri WebView。** `@deepseek-ai/dsh-bilibili-companion` 依赖 `ctx.desktopNative`，只发送配置的 B 站 URL 与完整的 active／inactive 状态。Desktop release 携带本包，但不会在交付的 profile 中挂载它。Rust 以隐藏状态创建 `bilibili-companion` 窗口，在状态变化之间保留操作者选择的 B 站内容，并在窗口被关闭后使用配置 URL 重建。本包仅限 Desktop；Web 与 headless profile 不能挂载它。

**汇总后的 `agent/status` 是播放状态的权威。** 插件维护公开状态为 `running` 的 agent 集合。从零个运行中的 agent 变为至少一个时，请求 Rust 显示、置前并播放；集合重新变空时，请求 Rust 暂停并隐藏。agent dispose（资源释放）会移除它占有的状态。播放是没有回放或模型上下文含义的瞬时展示状态，因此它不增加 Session 事件，也不修改 `agent-loop`。

**原生操作是封闭的，远程内容不具备 capability。** Node 到 Rust 的请求只携带 `{ url, active }`，绝不携带脚本、任意窗口标签或通用命令。Rust 再次校验 URL，只接受不含凭据的 B 站 HTTPS 顶层导航，拒绝下载，并把允许的新窗口请求重定向回同一个 WebView。Tauri IPC capability 只包含主窗口标签；远程 B 站窗口没有任何 Harness command 或 event 权限。Rust 只注入一个固定的播放／暂停辅助函数，并随应用持有窗口创建、可见性、焦点、导航和清理。

## 曾考虑的替代方案

**启动专用 Chromium 进程并控制一个 CDP page target。** 不采用，因为 B 站导航可以独立于 Host 创建或替换浏览器 target，而窗口焦点、用户所选标签页、profile 与进程清理仍是外部状态。页面脚本级弹窗拦截无法让该生命周期成为权威。

**控制操作者现有默认浏览器中的标签页。** 不采用，因为插件可能暂停错误的标签页、改变无关的浏览器 profile，或依赖该浏览器启动时并未开启的远程调试。

**把 B 站嵌入 Harness 主 WebView。** 不采用，因为远程站点内容绝不能共享主窗口标签或它的 Tauri IPC capability。独立标签与导航限制保留了这项安全分隔。

**监听持久的 `turn/start` 与 `turn/end` 事件。** 不采用，因为展示状态不属于回放，并且不同会话可以重叠。实时注册表状态已经定义整个 agent 活动，并为汇总提供精确的进程内主体。

**每个 agent 启动一个窗口。** 不采用，因为并发会话会产生相互竞争的声音和焦点切换；操作者需要的是 Harness 有工作时共用的一个追番界面。

## 后果

默认可选配置会创建一个隐藏的 B 站 WebView，至少一个 agent 工作时显示并播放，全部工作恢复空闲后暂停并隐藏。操作者可以在原生窗口中选择其他 B 站内容。非 B 站导航和下载会被拒绝，任何远程页面都不能调用 Harness IPC。

聚焦测试通过 Loader 启动真实 `cordis.yml`，并连接到 fake `DesktopNative`（测试替身）；测试随后断言初始空闲、agent 重叠、最终空闲、有界失败和 dispose 意图。TypeScript 协议测试固定封闭的原生消息。Rust 测试固定 URL 策略、仅限主窗口的 capability、播放意图和进程生命周期；Tauri 开发应用提供完整窗口组合验证。包的不变式 companion 刻意为空，因为权威窗口状态位于 Rust 中，Host 无法读取。
