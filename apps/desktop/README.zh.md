# DeepSeek Harness 桌面端 PoC

[English](README.md) | 中文

此应用是拟议 DeepSeek Harness 桌面壳的可执行 Tauri 概念验证。它把真实的已构建 `dsh web` Host 作为受控 Node.js 子进程启动，等待 Host 发布临时回环 URL，再让 Tauri WebView 导航到现有 Web 客户端。因此，该壳层无需把产品逻辑复制到 Rust，就能运行当前的 Host 组合、动态客户端 bundle、单次 RPC 和 WebSocket 下行链路。

PoC 特意在 `127.0.0.1` 上使用 HTTP，以便在桌面 IPC 载体完成前端到端验证壳层和现有应用。回环 HTTP 不是拟议的生产传输方式。[桌面壳 Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md) 定义了不监听端口的目标。

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

- Rust 在 Node Host 能够派生后代前，把它放入 Unix 进程组或 Windows Job Object。Tauri 退出时关闭受监督的 stdin 管道，等待 Host 释放 Cordis tree；如果超过配置的宽限期，则强制终止并回收完整进程树。
- Windows release 构建携带固定 Node 可执行文件和生产 `pnpm deploy` 闭包；壳层会优先选择这些资源，再回退到开发用的 `PATH` 和仓库路径。
- Host 在 `127.0.0.1` 上绑定操作系统分配的端口。WebView 导航围栏仅接受该子进程发布的精确端口。
- 导航后，现有 Web 应用无需修改即可运行。
- 加载页提供由 Rust 支持的目录选择器，作为窄范围原生操作探针；它未接入产品文件系统流程。
- 测试覆盖 URL 校验、导航围栏、通过受监督 stdin EOF 释放 profile，以及强制清理拒绝退出的后代进程。

## 有意保留的限制

v0.1 Windows 产物是未签名的开发者预览版。它已打包 Node.js 和已构建的 JavaScript 依赖图，但尚未用 Tauri IPC 替换 HTTP/WebSocket。受监督的 stdin EOF 请求证明了优雅生命周期集成，但不是规划中的分帧 sidecar 协议。原生目录选择器仅证明调用路径；生产文件系统选择必须回到 Host capability 及其权限策略，不能向 Web 客户端授予通用原生访问权。
