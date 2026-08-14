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

### 进程与信任模型

打包后的 Tauri 可执行文件是进程根。它使用固定的、应用自有的 Host 入口启动内置 Node 运行时，并通过显式启动消息传递配置。生产环境不得从 `PATH` 查找任意 `node` 或 Host 脚本。开发覆盖项保持显式启用，并在目标不存在时立即报错。

Rust 为 Node 进程及全部后代建立一个所有权域：Windows 使用 Job Object，Unix 使用进程组和父进程死亡处理。关闭时先发送协议级停止请求，等待 Host 服务和会话持久化静止，再在可配置期限后终止所有权域。只有 Host 完成 profile 加载、注册 API 方法并返回客户端启动清单后，启动才进入 ready。异常退出以可恢复壳层错误呈现，并附带有界 stderr 尾部。

WebView 不能导航到任意远程内容。应用资产使用 Tauri 应用 origin；客户端插件 bundle 使用应用自有 custom protocol；外部链接经过 allowlist 判定后在系统浏览器打开。Content Security Policy 排除远程脚本和通用网络访问。

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

首个可分发版本把已知 Node 运行时、已构建应用入口、工作区 package 闭包、客户端资产和所需原生模块作为 Tauri resource 或 sidecar 打包。初期不使用 Node Single Executable Applications，因为 profile 和插件解析需要普通模块与文件系统语义。构建 gate 在每个目标上使用打包的普通 Node 启动打包 Host 入口。

用户 profile、会话、设置和缓存位于不可变应用 bundle 之外的平台应用数据目录。Schema 和会话格式拒绝行为继续由现有 Node package 管理。Rust 更新器只在 Host 静止后替换应用产物；回滚不改写用户数据。

### 迁移顺序

1. 用 `apps/desktop` 中的回环 PoC 验证复用：Rust 在操作系统进程容器中监督真实的已构建 `dsh web`，只导航到子进程发布的临时端口，通过受监督的 stdin EOF 请求优雅释放，并提供一个原生对话框探针。
2. 增加私有分帧 Node/Rust 协议和 ready/关闭握手，同时仅把 Web server 保留为对照路径。
3. 实现桌面 `AbstractApiClient` 载体：Tauri command 承载上行请求，定向 event 承载下行流，回环仍提供应用资源。
4. 增加 Tauri custom-protocol boot manifest 与 bundle loader；从桌面 release 组合移除 `dsh-host-webserver`。
5. 增加打包 Node 与 JavaScript resource、应用数据目录解析，以及针对 PoC 已建立进程树所有权的跨平台打包 smoke test。
6. 把选定原生 provider 放到现有或新完成的 capability seam 后。每条 seam 都包括 Service Definition、Rust 支持的 provider bridge、Consumer、单元覆盖、组合 e2e 覆盖，以及在行为对产品或模型可见时的 keyless snapshot 覆盖。

### PoC 证据与限制

提交的 PoC 实现第 1–3 步和第 5 步的 Windows 打包范围。它使用真实的已构建 CLI 和 Web 应用，解析精确的 `dsh web: http://127.0.0.1:<port>/` 资源 URL，并等待私有协议的 ready 帧后再导航。`DSH-IPC/1` 行帧通过受监督 stdio 承载 fetch 形式的请求/响应、流、取消、关闭和致命错误消息。Node adapter 通过 Connection 受信任的同进程 Fetch 入口分发，因此桌面 RPC 不会绕行回环 HTTP。Rust 校验传输字段、关联待处理请求、把流事件定向到所属窗口、限制活动 route、忽略已取消请求的迟到响应，并在窗口销毁时取消窗口所属流。客户端 Connection 插件只为壳层标记的 WebView 选择 `DesktopApiClient`；Tauri command 承载 unary、respond 和通用 RPC，定向 Tauri event 以有界客户端 inbox 承载两条下行流。Node stdout 在写入下一帧前服从流背压。Tauri 应用 manifest 仅为目录探针和两个 IPC command 生成权限；主窗口 capability 向本地内容和受导航围栏约束的回环 Web UI 授予这些权限。

Rust 壳层在 Host 能够派生后代前创建 Unix 进程组或 Windows Job Object。壳层退出时发送分帧关闭请求，等待 CLI 有界释放 Cordis tree；超过可配置的外层宽限期后，强制终止并回收完整进程树；stdin EOF 仍作为协议损坏时的兜底。Windows release 构建把固定 Node 可执行文件和生产 `pnpm deploy` 闭包作为 Tauri resource 携带；release 准备会实体化工作区链接，使产物不依赖仓库路径。壳层在把 Host 入口交给 Node 前规范化 Windows verbatim resource 路径，并优先选择打包资源，再回退到开发路径。聚焦 TypeScript 与 Rust 测试覆盖帧拒绝、载体选择、同进程分发、URL 与导航授权、取消记录、协作退出和强制清理后代。

PoC 仍通过回环 HTTP 提供应用入口和动态客户端 bundle，并把 Web HTTP/WebSocket 载体保留为对照路径。自定义 bundle 协议、不含 `dsh-host-webserver` 的 release 组合、跨平台打包和经过 Host 策略的原生选择器仍待完成。加载页选择器只是证据，尚未经过 Host 文件系统策略。

## 考虑过的替代方案

- 用 Rust 重写 Host。拒绝，因为桌面集成不足以证明替换 Cordis 组合、TypeScript capability seam、持久会话行为和现有测试语料的合理性。
- 使用 Electron。它适合追求最大 Node 集成的场景，但壳层与 Host 的隔离较弱，打包的浏览器/运行时表面积更大。Tauri 更符合“薄原生所有者”的目标，同时允许 Web 客户端保持不变。
- 在生产环境保留回环 HTTP 和 WebSocket。拒绝，因为桌面应用不需要网络监听器，而且会额外引入 origin、认证、端口冲突、防火墙和关闭行为。
- 让 WebView 直接调用 Tauri 插件访问文件、凭据和进程。拒绝，因为这会绕过 Host 权限、capability、日志和 profile 组合。
- 立即把 Node 编译为单可执行文件。暂缓，因为动态 package 和 profile 解析是一等行为；打包普通 Node 运行时更容易独立验证和更新。

## 验收标准

- [ ] Release 桌面构建无需系统 Node 安装即可启动，且不打开监听端口。
- [ ] 现有 Host profile、会话、工具、设置和客户端插件组合正常运行，`agent-loop` 或 UI 功能 package 中不存在桌面专用分叉。
- [ ] 四个 RPC 象限、取消、有界交付、窗口关闭、Host 崩溃和壳层关闭均有桌面载体的聚焦测试。
- [ ] Host 继续作为文件系统、凭据、进程和模型可见操作的权威；Rust provider 不能通过通用 WebView 逃生口访问。
- [ ] Windows、macOS 和 Linux 打包 smoke test 证明启动 ready、一次单次调用、一次下行事件、一次动态客户端 bundle 加载、优雅关闭和后代进程清理。
- [ ] Release Content Security Policy 和导航测试拒绝远程脚本、任意网络和任意本地文件访问。
- [ ] 构建输入固定 Node 运行时和原生依赖，打包 Host smoke test 针对生成产物而不是源码运行。
- [ ] 桌面行为变化同步更新受影响的 README/JSDoc、本 note 或其后继文档，并在输出对产品或模型可见时更新 keyless snapshot。

## 风险

- 系统 WebView 差异可能暴露浏览器测试矩阵未覆盖的渲染或 custom-protocol 差异。打包 smoke 和定向 WebView e2e test 必须负责此信号。
- 原生 Node 模块可能需要逐目标打包和签名规则。产物 gate 必须从打包布局枚举并加载它们。
- 动态 bundle 加载可能与 Content Security Policy 漂移。Bundle 标识符、字节和脚本执行策略需要一套经测试的应用 origin 设计。
- Rust 与 TypeScript 载体实现可能分化。生成的传输 envelope fixture 和共享 transcript test 应验证两侧，同时不复制方法 schema。
- 如果所有权在 spawn 后才附加，或被 provider 绕过，后代进程可能比 Host 存活更久。进程组/Job Object 必须在 spawn 时建立，teardown test 必须检查完整进程树。
