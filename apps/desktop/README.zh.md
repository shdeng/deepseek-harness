# DeepSeek Harness 桌面端 PoC

[English](README.md) | 中文

此应用是拟议 DeepSeek Harness 桌面壳的可执行 Tauri 概念验证。它把真实的已构建 `dsh web` Host 作为受控 Node.js 子进程启动，建立私有分帧 stdio 协议，并且只在协议和临时回环资源 URL 都就绪后让 Tauri WebView 导航。现有 Web 客户端保留产品逻辑，API 流量则通过 Tauri IPC 沿 WebView → Rust → Node 传递。

PoC 仍通过 `127.0.0.1` 上的 HTTP 提供应用入口和动态客户端 bundle。单次调用、通用 RPC、客户端响应及两条下行事件流使用桌面 IPC 载体；Web HTTP/WebSocket 载体仍作为对照路径挂载。[桌面壳 Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md) 定义了剩余的自定义资源协议和不监听端口目标。

## 运行

先安装一次工作区依赖，再启动 PoC：

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

使用内置 Node 运行时和生产 Host 依赖闭包构建 Windows 便携版载荷及安装包：

```powershell
pnpm --filter @deepseek-ai/dsh-desktop run release:windows
```

生成的 NSIS 安装包位于 `apps/desktop/src-tauri/target/release/bundle/nsis/`。便携目录由 `dsh-desktop-poc.exe` 及放在其旁边的 `release-resources/host`、`release-resources/runtime` 目录组成。

壳层接受以下开发覆盖项：

| 变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_DESKTOP_NODE` | Host 使用的 Node.js 可执行文件 | `PATH` 中的 `node` |
| `DSH_DESKTOP_CLI` | 已构建的 `dsh` CLI 入口 | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host 工作目录，包括 profile 和设置解析的基准目录 | 壳层启动目录 |
| `DSH_DESKTOP_SHUTDOWN_GRACE_MS` | Host 关闭请求与强制终止进程树之间的宽限期（1–60000 毫秒） | `7000` |

## 已实现范围

- Rust 在 Node Host 能够派生后代前，把它放入 Unix 进程组或 Windows Job Object。Tauri 退出时发送分帧关闭请求并等待 Host 释放 Cordis tree；如果超过配置的宽限期，则强制终止并回收完整进程树。协议管道失败时仍以 stdin EOF 兜底。
- 带版本的 `DSH-IPC/1` 行帧承载 ready、shutdown、fetch 形式的请求/响应、流、取消和致命错误消息。Rust 校验传输字段、关联待处理调用、把流事件定向到所属窗口、安全丢弃已取消请求的迟到响应，并在窗口关闭时取消其流。
- 客户端 Connection 插件仅在壳层标记的 WebView 中选择 `DesktopApiClient`。Tauri command 承载 unary、respond 和通用 RPC，定向 Tauri event 承载 `events.mux` 与 `events.host`。Node adapter 通过 HTTP adapter 使用的同一组 Connection 进程内 Fetch handler 分发请求。
- Tauri 应用 manifest 为三个应用 command 生成权限；主窗口 capability 仅向本地应用内容和受导航围栏约束的 `127.0.0.1` Web UI 授予这些权限。
- 活动请求数和客户端流队列具有固定安全上限；Node stdout 写入在产生更多流帧前等待 drain。
- Windows release 构建携带固定 Node 可执行文件和生产 `pnpm deploy` 闭包；壳层会优先选择这些资源，再回退到开发用的 `PATH` 和仓库路径。
- Host 在 `127.0.0.1` 上绑定操作系统分配的端口。WebView 导航围栏仅接受该子进程发布的精确端口。
- 导航后，现有 Web 应用和客户端插件图继续运行；只有 Connection 载体选择属于桌面端特例。
- 加载页提供由 Rust 支持的目录选择器，作为窄范围原生操作探针；它未接入产品文件系统流程。
- 测试覆盖私有帧校验、载体选择与分发、URL 与导航校验、profile 优雅释放、迟到取消记录，以及强制清理拒绝退出的后代进程。

## 有意保留的限制

v0.1 Windows 产物是未签名的开发者预览版。回环 Web 服务器仍提供应用入口和动态客户端 bundle，因此构建仍会打开监听端口，并保留 Web 载体作为回退。下一项传输工作是使用 Tauri 自定义协议承载 Host 生成的 boot manifest 和 bundle 字节，随后建立不包含 `dsh-host-webserver` 的桌面 release 组合。原生目录选择器仅证明调用路径；生产文件系统选择必须回到 Host capability 及其权限策略，不能向 Web 客户端授予通用原生访问权。
