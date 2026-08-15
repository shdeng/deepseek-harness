# Agent Note：Tauri 桌面壳——保留 Node Host，并把操作系统资源所有权迁入 Rust

Status: proposed

[English](2026-08-14-tauri-desktop-shell.md) | 中文

## 问题

DeepSeek Harness 已有插件组合的 Node.js Host、动态组合的 Web 客户端和与通道无关的四象限 RPC 模型。桌面应用应复用这些产品层，同时获得原生窗口、生命周期、打包、更新、凭据、对话框和进程管理能力。

完整 Rust 重写会同时替换成熟的 Cordis 插件运行时、TypeScript Service Definition、模型可见会话日志、profile 加载和客户端插件图。这些工作与桌面集成关系很小，还会产生第二套扩展系统。另一方面，只把现有 Web 服务器放进桌面窗口会保留监听端口、弱化进程所有权，也不能为原生操作建立受控路径。

我们需要一种桌面架构：保留现有 Host 和 Client 职责，让 Rust 成为操作系统资源的所有者，并逐步迁移原生工作，同时禁止 WebView 绕过 Host 权限或会话语义。

## 方案

新增 `apps/desktop` Tauri 应用，包含两个运行时：

- Rust 壳层管理应用窗口、应用生命周期、打包运行时发现、更新、安全凭据句柄、原生对话框、通知、深链接以及 Node Host 进程树。
- 现有 Node.js Host 继续作为 Cordis 组合、会话、profile、工具、agent 执行、设置、文件系统策略和客户端插件发现的产品权威。
- 现有 Web 客户端继续作为 UI。桌面专用客户端载体继承 `AbstractApiClient`，不分叉 UI 功能。

生产拓扑如下：

```text
Tauri WebView
  client plugins and desktop AbstractApiClient carrier
          │ Tauri IPC: unary requests, downlink channels, bundle reads
          ▼
Rust shell
  window + lifecycle + updater + native providers + sidecar supervisor
          │ private framed stdio/local IPC, no listening socket
          ▼
Node Host sidecar
  dsh-host-runtime + ApiProxy + profile/session/tool capability plugins
```

`apps/desktop` 是应用组合，不是可复用 package。Capability 行为留在 `packages/`；应用专用传输和启动接线留在该应用内。此方案不修改 `agent-loop`。

### 组合边界

图形应用组合按职责拆分，而不是沿用历史入口。`dsh-gui-app` 携带两个图形表层共用的传输无关 Host 服务、客户端模块注册表、Connection 服务、客户端插件清单与按会话 agent preset。`dsh-web-app` 添加 HTTP server、`/api`、WebSocket 下行流、`/plugins`、frontend-static fallback、HMR、浏览器信任和 Web 启动参数。`dsh-desktop-app` 选择 Desktop 原生 provider，且不包含 Web server、静态服务、HTTP route、WebSocket 或 HMR 行。`web` 模板组合 `base + llm-multi-provider + gui-app + web-app`；`desktop` 模板组合 `base + gui-app + desktop-app`。

传输无关 package 不得自行发明网络所有者。`dsh-client-modules` 发现、哈希并读取已构建的客户端资源。Web 组合把这些读取映射到 `/plugins`；Rust 壳层把它们映射到 `dsh-plugin://localhost/<opaque-digest>/client.js`。`dsh-client-connection` 始终提供受信任的同进程 Fetch bridge，而 HTTP 与 WebSocket adapter 仅在 Web server service 存在时激活。

### 进程与信任模型

打包后的 Tauri 可执行文件是进程根。它使用固定的、应用自有的 Host 入口启动内置 Node 运行时，并通过显式启动消息传递配置。生产环境不得从 `PATH` 查找任意 `node` 或 Host 脚本。开发覆盖项保持显式启用，并在目标不存在时立即报错。

Rust 为 Node 进程及全部后代建立一个所有权域：Windows 使用 Job Object，Unix 使用进程组和父进程死亡处理。关闭时先发送协议级停止请求，等待 Host 服务和会话持久化静止，再在可配置期限后终止所有权域。只有 Host 完成 profile 加载、注册 API 方法并返回客户端启动清单后，启动才进入 ready。异常退出以可恢复壳层错误呈现，并附带有界 stderr 尾部。

WebView 不能导航到任意远程内容。应用资产使用 Tauri 应用 origin；客户端插件 bundle 使用应用自有 custom protocol；外部链接经过 allowlist 判定后在系统浏览器打开。Content Security Policy 排除远程脚本和通用网络访问。由于 Cordis 客户端模块 evaluator 与 schemastery 回调复活会通过 `new Function` 执行 Host 提供的受信任代码，策略明确允许 `unsafe-eval`；由于受信任的客户端 bundle 会在运行时实体化各自的作用域 CSS，策略也允许内联样式。这些例外不会引入远程脚本、样式、图片或字体来源，也不会削弱导航限制。

### 桌面 RPC 载体

桌面载体保留现有四象限消息定义和校验，只改变物理传输：

| 逻辑流量 | 桌面传输 |
|---|---|
| Client 单次请求和 Host 响应 | Tauri `invoke` 到 Rust、分帧请求到 Node，再把关联响应返回 WebView |
| Host 请求和 Client 响应 | Node 分帧消息、Rust event/channel 到选定窗口，再返回关联的客户端响应 |
| Host 通知 | Node 分帧消息通过有界 Tauri channel 转发 |
| Client 通知 | Tauri `invoke`，除传输确认外无应用响应 |

Rust 把 RPC payload 视为不透明、已校验的 JSON envelope，并按请求标识符和窗口标识符路由。TypeScript 协议仍是唯一语义来源。生成的 Rust envelope 类型可以管理传输字段，但 Rust 不得复制方法专用的请求或响应 schema。

背压和取消属于协议行为，不是通道的偶然行为。每个流都有有界队列；窗口关闭会取消其订阅；Host 退出会拒绝待处理调用；壳层关闭会先停止接受新调用，再请求 Host 静止。实现必须证明迟到响应、重复终止消息和已关闭 WebView 不会保留路由或导致壳层 panic。

### 动态客户端启动与资产

Host 继续生成客户端插件图和 `__DSH_BOOT__` 清单。启动期间，它通过私有 sidecar 协议返回该清单。壳层通过 Tauri custom URI protocol 提供静态应用入口和请求的插件 bundle 字节，并使用清单中的不透明 bundle 标识符作为键；它不暴露任意文件系统路径。

开发 HMR 可以使用显式启用的回环开发服务器。Release 构建只使用打包资产和 Host 提供的插件 bundle。Web server package 不出现在 release 桌面组合中。

### 原生 capability provider

原生操作是由 Rust 支持的 Host capability，而不是不受限制的 JavaScript command。方向如下：

```text
client intent → existing Host API/tool → Host policy and permission → Rust provider → operating system
```

首批 provider 候选包括目录/文件选择、安全凭据存储、通知、应用元数据和受控外部链接打开。文件系统读写仍受 `dsh-fs` 策略约束；选择器把选中资源返回 Host，不向 WebView 授予通用路径访问权。原生 provider 请求跨越 Rust/Node 进程边界时使用 branded 不透明标识符。

仅影响窗口的最小化或聚焦等操作，在无法改变产品数据、agent 输入、权限或持久状态时可以是壳层 command。所有模型可见内容仍必须可从会话日志重建。

### 打包与更新

首个可分发版本把已知 Node 运行时、已构建应用入口、应用专用工作区 package 闭包、客户端资产和所需原生模块作为 Tauri resource 或 sidecar 打包。桌面 release 构建会在 profile template、TypeScript reference、JavaScript bundle 和生产 deploy 各阶段选择 DeepSeek provider 组合。可选 pi-ai bundle 及其 OpenAI 与 Anthropic SDK 闭包，以及 Codex 与 Claude agent adapter，仍可供通用 CLI profile 使用，但不进入桌面 release 输入。若被排除的 package 通过传递依赖重新进入，或者必需的内部 peer 缺失，manifest 审计会使 release 准备失败。初期不使用 Node Single Executable Applications，因为 profile 和插件解析需要普通模块与文件系统语义。构建 gate 在每个目标上使用打包的 Node 运行时启动打包 Host、观察 ready、请求分帧关闭并要求干净退出。

用户 profile、会话、设置、凭据、附件和缓存位于 `$DSH_HOME`（默认 `~/.dsh`），不在安装目录或便携版应用目录中。Schema 和会话格式拒绝行为继续由现有 Node package 管理。初始 release 检查器在启动时查询一次本仓库最新的稳定 GitHub Release，校验其数字版本和准确的仓库发布 URL，并在打开页面供用户手动下载前请求确认。它不下载、执行、替换或回滚应用产物。未来的自动安装器需要签名产物，并且必须在替换应用文件前使 Host 静止；安装和回滚都不得改写 `$DSH_HOME`。

### 迁移顺序

1. v0.1–v0.2 已完成：用回环 PoC 验证复用，建立进程树所有权，打包固定 Node 运行时和 Desktop Host 闭包，加入分帧协议，并把产品 RPC 切换到 Tauri 载体。
2. v0.3 已完成：从 Web 传输中拆出共享图形组合，通过私有协议返回启动清单，以应用自有 custom protocol 提供动态 bundle，嵌入已构建应用入口，并从 Desktop release 移除 Web server 闭包。
3. v0.3 之后已完成：把目录／文件选择迁到完整 Host capability seam 后，由 Desktop provider 调用 Rust，并从 WebView capability 移除通用 picker command。
4. v0.3 之后已完成：通过 Host 到 Rust 的私有协议迁移安全凭据存储、受控外链打开、通知、应用元数据和深链接。文件系统和 subprocess 执行留在 Node，直到另有论证的 provider 能保留其策略与流式行为。
5. 稳定发布前：加入 macOS 与 Linux 产物 job、签名和公证、打包 WebView 交互覆盖、协议 transcript 一致性 fixture，以及保留 `$DSH_HOME` 的更新安装器设计。

### v0.3 证据与限制

提交的 v0.3 基础会启动 `--profile desktop`，等待包含客户端启动清单的 `ready` 帧，并且不再启动 `dsh web`。`DSH-IPC/1` 行帧通过受监督 stdio 承载 Fetch 形式的请求与响应、流帧、取消、不透明资源读取、关闭和致命错误。Node adapter 通过 Connection 受信任的同进程 Fetch 入口分发产品 RPC。Rust 校验传输字段与 custom-protocol 资源 URL、关联待处理请求、把流事件定向到所属窗口、限制活动 route、忽略已取消请求的迟到响应，并在窗口销毁时取消窗口所属流。带壳层标记的 WebView 选择 `DesktopApiClient`；Tauri command 承载 unary、respond 和通用 RPC，定向 Tauri event 以有界客户端 inbox 承载两条下行流。

Rust 壳层在 Host 能够派生后代前创建 Unix 进程组或 Windows Job Object。壳层退出时发送分帧关闭请求，等待 CLI 有界释放 Cordis tree；超过可配置的外层宽限期后，强制终止并回收完整进程树；stdin EOF 仍作为协议损坏时的兜底。Windows release 构建把固定 Node 可执行文件和仅含 DeepSeek 的生产 `pnpm deploy` 闭包作为 Tauri resource 携带；release 准备会实体化工作区链接，使产物不依赖仓库路径。Release 命令使用桌面专用编译器和 bundler 选择，而不是仓库级全量构建；它从仅声明依赖的桌面 runtime root 执行隔离的注入式 deploy 且不改变仓库安装状态，拒绝被排除的 package manifest 和缺失的必需内部 peer，然后验证打包 Host 的启动与协作关闭。壳层传入 Cordis 配置 HMR 所需的显式 Node loader-internals 开关，在把 Host 入口交给 Node 前规范化 Windows verbatim resource 路径，并优先选择打包资源，再回退到开发路径。Release 构建还会执行上述有时限的 GitHub 检查；检查失败不阻塞 Host 或 WebView 启动，并且不会写入用户数据。聚焦 TypeScript 与 Rust 测试覆盖帧拒绝、载体选择、无需 HTTP 信任头的特权同进程分发、URL 与导航授权、取消记录、协作退出、强制清理后代、release 选择、受信任发布 URL 和准确的更新提示。原生更新对话框的打包交互自动化仍待完成。

应用入口嵌入 Tauri 二进制，动态 bundle 使用只包含 Host 生成不透明摘要的规范 `dsh-plugin://localhost` URL。Rust 校验这些 URL 后，会在 Windows 上把它们映射为 WebView2 的 `http://dsh-plugin.localhost` custom-protocol origin；macOS 与 Linux 保留规范 scheme。CSP 回归测试固定了狭窄的动态代码例外并拒绝远程脚本 scheme；初始化脚本会显示启动异常，避免留下空白 WebView。Release policy 禁止 `dsh-web-app`、`dsh-host-webserver`、`dsh-host-frontend-static`、`dsh-web-frontend` 与 `dsh-client-hmr` 进入 Desktop 闭包。打包 Host smoke 会验证 ready 清单、Host 在 Windows 上不持有 TCP listener、一次 bundle 读取、原生应用元数据、一次 `host.describe` unary 调用和分帧协作关闭。反向私有协议现在承载由 Host 发起的原生请求和由 Rust 发起的深链接事件。`ctx.desktopNative` 提供目录选择、受控 HTTP(S) 打开、通知投递和应用元数据；Desktop 凭据提供方在 Rust 对话框中采集 secret，将其存入平台凭据库，并通过同进程 Rust 库解析，因此 WebView 与 stdio 帧只携带凭据引用。主窗口 ACL 只保留事件监听和三个应用 RPC command，不授予 picker、凭据、opener、通知、元数据或深链接插件 command。Rust 测试还覆盖强制清理后代与原生 URL 策略。剩余缺口是自动化的打包 WebView 交互 smoke、在打包产物中实际执行一次下行 event、非 Windows 打包与签名、通知操作，以及未来可能进行的文件系统或 subprocess provider 迁移。

## 考虑过的替代方案

- 用 Rust 重写 Host。拒绝，因为桌面集成不足以证明替换 Cordis 组合、TypeScript capability seam、持久会话行为和现有测试语料的合理性。
- 使用 Electron。它适合追求最大 Node 集成的场景，但壳层与 Host 的隔离较弱，打包的浏览器/运行时表面积更大。Tauri 更符合“薄原生所有者”的目标，同时允许 Web 客户端保持不变。
- 在生产环境保留回环 HTTP 和 WebSocket。拒绝，因为桌面应用不需要网络监听器，而且会额外引入 origin、认证、端口冲突、防火墙和关闭行为。
- 让 WebView 直接调用 Tauri 插件访问文件、凭据和进程。拒绝，因为这会绕过 Host 权限、capability、日志和 profile 组合。
- 立即把 Node 编译为单可执行文件。暂缓，因为动态 package 和 profile 解析是一等行为；打包普通 Node 运行时更容易独立验证和更新。

## 验收标准

- [x] Windows release 桌面构建携带自身 Node 运行时，且 Host 不打开监听端口。
- [x] 现有 Host profile、会话、工具、设置和客户端插件组合正常运行，`agent-loop` 或 UI 功能 package 中不存在桌面专用分叉。
- [ ] 四个 RPC 象限、取消、有界交付、窗口关闭、Host 崩溃和壳层关闭均有桌面载体的聚焦测试。
- [x] Host 继续作为文件系统、凭据、进程和模型可见操作的权威；Rust provider 不能通过通用 WebView 逃生口访问。
- [ ] Windows、macOS 和 Linux 打包 smoke test 证明启动 ready、一次单次调用、一次下行事件、一次动态客户端 bundle 加载、优雅关闭和后代进程清理。
- [x] Release Content Security Policy 和导航测试在配置的壳层边界拒绝远程脚本、任意网络和任意本地文件访问。
- [x] Windows 构建输入固定 Node 运行时，打包 Host smoke test 针对生成产物而不是源码运行。
- [x] Desktop 行为变化同步更新受影响的 README/JSDoc 与本 note；v0.3 不改变产品或模型可见 transcript。

## 风险

- 系统 WebView 差异可能暴露浏览器测试矩阵未覆盖的渲染或 custom-protocol 差异。打包 smoke 和定向 WebView e2e test 必须负责此信号。
- 原生 Node 模块可能需要逐目标打包和签名规则。产物 gate 必须从打包布局枚举并加载它们。
- 动态 bundle 加载可能与 Content Security Policy 漂移。Bundle 标识符、字节和脚本执行策略需要一套经测试的应用 origin 设计。
- Rust 与 TypeScript 载体实现可能分化。生成的传输 envelope fixture 和共享 transcript test 应验证两侧，同时不复制方法 schema。
- 如果所有权在 spawn 后才附加，或被 provider 绕过，后代进程可能比 Host 存活更久。进程组/Job Object 必须在 spawn 时建立，teardown test 必须检查完整进程树。
