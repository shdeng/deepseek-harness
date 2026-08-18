# Agent Note: Desktop 游戏伴随窗口与本地游戏 Provider

Status: implemented

[English](2026-08-17-desktop-game-companion-and-local-providers.md)

## Problem

长时间 Harness 工作会让操作者等待，但 B 站伴随窗口不能安全承载交互游戏。游戏需要持久的窗口内状态、Agent 需要注意时的输入阻断、多个资产，以及不依赖单个远程 URL 的 Provider 身份。把游戏加载到主 WebView 还会让娱乐代码不必要地接近 Session 数据与应用 IPC。

## Decision

**Host 游戏注册表把游戏 Provider 与 Desktop 展示分开。** `@deepseek-ai/dsh-game` 持有 `ctx.games`；Provider 插件同步注册稳定的 kebab-case id、有界标题和自包含 UTF-8 HTML／CSS／JavaScript 资产集。注册表校验规范化路径、封闭媒体类型、单资产与单游戏字节上限和必需的 `index.html`，然后生成 SHA-256 版本 URL。Provider 释放会移除 id 与摘要映射，并在变更提交后发出 `games/change`。

**私有 Desktop 协议提供游戏资产，但不暴露文件系统路径。** Node sidecar 按摘要和规范化路径响应 `game-asset-read`。Rust 只接受 `dsh-game://localhost/<sha256>/index.html` 游戏入口，把它映射成平台自定义协议形式，并持有独立的 `game-companion` WebView。窗口拒绝其他顶层导航、下载和新窗口。它的标签不属于任何 Tauri capability，因此游戏内容没有 Harness command、event、Session 传输、文件系统或 subprocess 权限。

**一个 companion 插件持有互斥实时设置。** `@deepseek-ai/dsh-game-companion` 在 `mode: off | bilibili | game` 组合基础层之上注册 `companion` settings namespace。“插件配置”卡片写入该 namespace，模式变化会立即协调。game 模式发送 `hidden`／`playable`／`attention` 状态，Bilibili 模式发送 active／inactive 媒体意图，off 则让两者都不激活。待处理的 `approval/request` 会暂停任一模式。Desktop profile 挂载注册表、2048 Provider 与 companion，并配置为 `mode: off`。

**2048 验证 Provider 与展示约定。** `@deepseek-ai/dsh-game-2048` 提供离线、可键盘操作的游戏，包含清晰焦点、实时状态、reduced-motion 行为和隔离来源 local storage。Host 状态事件会在 `playable` 之外阻断移动。Desktop release 会携带注册表、Provider 和 Consumer 包，但默认不挂载这些行。

## Alternatives considered

**复用 B 站媒体请求并替换成游戏 URL。** 不采用，因为其布尔播放意图不能表达完成或审批注意状态，而接受任意游戏 URL 会削弱刻意限定为 B 站的导航策略。

**把 2048 直接编译进 Rust 壳层。** 不采用，因为每个新游戏都将要求一次 Desktop release，也无法验证插件 Provider 生命周期。内容摘要寻址的 Host 资产让窗口权限继续归 Rust，同时让本地插件持有游戏内容。

**在主 Harness WebView 内渲染游戏。** 不采用，因为主窗口携带应用 command、event 和 Session 传输。独立且无 capability 的标签让娱乐内容离开这些权限。

**启动外部游戏进程。** 首个 Provider 不采用，因为外部应用无法跨平台可靠提供暂停、输入阻断、存档、资源所有权和进程树清理。

## Consequences

操作者可以选择启用本地 2048 窗口；至少一个 Agent 工作时才可游玩，工作完成或需要审批时则成为明确的注意界面。游戏状态保持为本地展示数据，从不进入 Session 日志或模型上下文。

注册表目前只接受文本 Web 资产，Desktop carrier 是唯一展示 Provider。用户问题等待与普通运行活动无法区分，因为 `ctx.userQuestions` 不发布实时 pending 事件；伴随窗口只会在 Agent 后续进入 idle 时暂停。

聚焦测试通过 Loader 启动真实注册表、2048 Provider 与伴随窗口，并使用 fake Desktop 服务；浏览器测试覆盖移动、注意阻断、持久化与无障碍状态；私有协议与 Rust 测试固定摘要／路径校验、封闭原生意图、导航策略、状态注入和窗口 capability 隔离。
