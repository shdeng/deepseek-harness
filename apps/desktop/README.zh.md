# DeepSeek Harness Desktop

[English](README.md) | 中文

此应用是 DeepSeek Harness 的 Tauri Desktop 组合。它把专用 `desktop` profile 作为受控 Node.js Host 进程启动，从 Tauri 应用源加载打包后的 Web 客户端，并通过 WebView → Rust → Node IPC 承载产品流量。现有 Cordis Host、会话、工具、profile 与客户端插件继续作为权威实现；Rust 持有窗口、进程树、打包运行时、生命周期、更新提示与自定义客户端资产协议。

Release Desktop 组合不会打开应用监听套接字。Host 在 `DSH-IPC/1` ready 帧中发送启动 manifest；其中的 URL 携带不透明 `dsh-plugin://` 标识符，Rust 通过私有 sidecar 协议解析每个请求的 bundle，不暴露文件系统路径。单次调用、通用 RPC、客户端响应及两条下行事件流使用同一 Desktop 载体。详见[桌面壳 Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md)。

## 运行

先安装一次工作区依赖，再启动应用：

```powershell
pnpm install
pnpm desktop:dev
```

`desktop:dev` 会先构建 Host、Web 客户端和 CLI，再启动 Tauri。如果这些产物已经是最新的，可跳过准备步骤：

```powershell
pnpm desktop:dev:prepared
```

可独立运行 Rust 检查：

```powershell
pnpm desktop:check
pnpm desktop:test
```

使用内置 Node 运行时和桌面端专用生产 Host 依赖闭包构建 Windows 便携版载荷及安装包：

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run release:windows
```

此命令使用桌面端专用 TypeScript 和 bundle 构建，再从 `@deepseek-ai/dsh-desktop-runtime` 而非通用 CLI package 执行 deploy。Release 组合仅包含 DeepSeek：多 Provider pi-ai bundle、OpenAI 与 Anthropic SDK、Codex 与 Claude agent SDK 及其 Harness adapter 均不进入构建和 deploy 闭包。Release 准备会扫描所有已部署 package manifest；若被排除的 package 通过传递依赖重新进入，则立即失败。通用 `dsh web` 和 `dsh headless` profile 仍包含可选的多 Provider bundle。

生成的 NSIS 安装包位于 `apps/desktop/src-tauri/target/release/bundle/nsis/`。便携目录由 `deepseek-harness-app.exe` 及放在其旁边的 `release-resources/host`、`release-resources/runtime` 目录组成。

壳层接受以下开发覆盖项：

| 变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_DESKTOP_NODE` | Host 使用的 Node.js 可执行文件 | `PATH` 中的 `node` |
| `DSH_DESKTOP_CLI` | 已构建的 `dsh` CLI 入口 | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host 工作目录，包括 profile 和设置解析的基准目录 | 壳层启动目录 |
| `DSH_DESKTOP_SHUTDOWN_GRACE_MS` | Host 关闭请求与强制终止进程树之间的宽限期（1–60000 毫秒） | `7000` |

## 更新与用户数据

Release 构建在启动时检查一次本仓库最新的稳定 GitHub Release。若其数字版本更新，原生确认对话框会询问是否用系统浏览器打开该版本的准确发布页。应用不会静默下载、执行或替换二进制文件；取消提示后继续运行当前版本。网络、响应校验或浏览器打开失败只会记录日志，不会阻塞 Host 或 WebView 启动。

Profile、设置、凭据引用、附件和会话历史位于 `$DSH_HOME`（默认 `~/.dsh`），不在 NSIS 安装目录或便携版应用目录中。Desktop 凭据值位于 Windows Credential Manager、macOS Keychain 或 Linux Secret Service。更新检查不会写入这两类存储；安装较新版本时只替换应用文件。若未来版本明确宣布用户数据迁移，请在升级前保留备份。

## 已实现范围

- Rust 在 Node Host 能够派生后代前，把它放入 Unix 进程组或 Windows Job Object。Tauri 退出时发送分帧关闭请求并等待 Host 释放 Cordis tree；如果超过配置的宽限期，则强制终止并回收完整进程树。协议管道失败时仍以 stdin EOF 兜底。
- 带版本的 `DSH-IPC/1` 行帧承载启动 manifest、不透明客户端资产读取、shutdown、fetch 形式的请求/响应、流、取消和致命错误。Rust 校验传输字段，在 Windows 上把规范的 `dsh-plugin://localhost` 资源 URL 映射到 WebView2 的 `http://dsh-plugin.localhost` custom-protocol origin、关联待处理调用、把流事件定向到所属窗口、安全丢弃已取消请求的迟到响应，并在窗口关闭时取消其流。
- 客户端 Connection 插件仅在壳层标记的 WebView 中选择 `DesktopApiClient`。Tauri command 承载 unary、respond 和通用 RPC，定向 Tauri event 承载 `events.mux` 与 `events.host`。Node adapter 通过 HTTP adapter 使用的同一组 Connection 进程内 Fetch handler 分发请求。
- `ctx.desktopNative` 是 Rust 持有的 OS 操作 Service Definition。目录选择 Provider、凭据 Provider、外链与通知 API Consumer、应用元数据和深链接 Host stream 都使用其反向请求／事件通道。WebView 没有 picker、keychain、notification、opener、metadata 或 deep-link 插件的直接权限。
- Desktop 凭据在 Rust 原生对话框中输入并直接写入操作系统凭据库。WebView 和分帧 stdio 只携带 `CredentialRef` 句柄；Node 通过打包的 Rust 动态库为提供方解析凭据。Desktop 传输会在 Node 管道前拒绝明文凭据写入和模型发现 key。
- Rust 只接受不含凭据的 HTTP(S) 外链和 `deepseek-harness://session/<session-id>` 深链接。后台会话从运行变为空闲时发送原生通知；接受深链接后会聚焦主窗口，并通过 Host stream 选择目标会话。
- Tauri 应用 manifest 为应用 command 生成权限；主窗口 capability 只向打包后的本地内容授权。Release 导航仅接受 Tauri 应用源；debug 构建还接受注入 Tauri `devUrl` 的准确开发源，其他回环端口仍会被拒绝。CSP 排除远程脚本与通用网络访问，只允许应用自有协议提供客户端 bundle；由于受信任的 Cordis 客户端加载器与 schemastery 回调复活会用 `new Function` 编译 Host 提供的代码，因此明确允许 `unsafe-eval`；由于这些 bundle 会在运行时实体化各自的作用域 CSS，因此也允许内联样式。
- 活动请求数和客户端流队列具有固定安全上限；Node stdout 写入在产生更多流帧前等待 drain。
- Windows release 构建携带固定 Node 可执行文件和仅含 DeepSeek 的生产 `pnpm deploy` 闭包。专用构建入口会在打包前排除 pi-ai、OpenAI、Anthropic、Codex 与 Claude package。已部署 manifest 审计会拒绝被排除的 package 和缺失的必需内部 peer；壳层会优先选择这些资源，再回退到开发用的 `PATH` 和仓库路径。
- Release 构建会校验最新的稳定 GitHub Release，并在打开受信任的发布页前请求确认；下载和安装仍由用户明确执行。
- 专用 Desktop profile 组合 `dsh-base`、传输无关的 `dsh-gui-app` 与 `dsh-desktop-app`；release 闭包禁止 `dsh-web-app`、`dsh-host-webserver`、前端静态服务与客户端 HMR。
- 现有 Web 应用与 Host 编写的客户端插件图从打包／自定义协议资产运行；只有启动过程和 Connection 传输属于 Desktop 特例。
- 测试覆盖私有帧校验、载体选择与分发、URL 与导航校验、profile 优雅释放、迟到取消记录，以及强制清理拒绝退出的后代进程。

## 有意保留的限制

v0.3 Windows 产物仍是未签名的开发者预览版。应用打开 GitHub Release 页面后，升级仍需手动完成；目前没有签名的应用内安装器、后台下载或自动回滚。macOS／Linux 打包与签名、通知交互动作、完整的打包 WebView 自动化，以及更广泛的原生文件系统／子进程 Provider 仍未完成。
