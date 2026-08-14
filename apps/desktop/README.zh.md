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

壳层接受以下开发覆盖项：

| 变量 | 含义 | 默认值 |
|---|---|---|
| `DSH_DESKTOP_NODE` | Host 使用的 Node.js 可执行文件 | `PATH` 中的 `node` |
| `DSH_DESKTOP_CLI` | 已构建的 `dsh` CLI 入口 | `apps/cli/lib/bin.js` |
| `DSH_DESKTOP_CWD` | Host 工作目录，包括 profile 和设置解析的基准目录 | 壳层启动目录 |

## 已实现范围

- Rust 管理 Node 子进程，捕获其输出，检测异常退出，并在 Tauri 退出时终止和回收直接子进程。
- Host 在 `127.0.0.1` 上绑定操作系统分配的端口。WebView 导航围栏仅接受该子进程发布的精确端口。
- 导航后，现有 Web 应用无需修改即可运行。
- 加载页提供由 Rust 支持的目录选择器，作为窄范围原生操作探针；它未接入产品文件系统流程。
- 单元测试覆盖 URL 校验和导航围栏。

## 有意保留的限制

这不是可分发的桌面版本。它尚未打包 Node.js 或已构建的 JavaScript 依赖图，尚未用 Tauri IPC 替换 HTTP/WebSocket，也尚未实现 Host 优雅关闭握手或管理完整的后代进程树。原生目录选择器仅证明调用路径；生产文件系统选择必须回到 Host capability 及其权限策略，不能向 Web 客户端授予通用原生访问权。
