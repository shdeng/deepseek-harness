# `@deepseek-ai/dsh-web-app`

[English](README.md) | 中文

在 [`dsh-gui-app`](../gui-app/README.md) 之后应用的浏览器传输组合包。共享组合包持有图形 Host 服务、workspace／session 组合、客户端模块注册表与客户端插件清单。本包只添加 Web 传输和 Web 运行时策略：webserver、HTTP `/api`、WebSocket 下行流、`/plugins` 客户端资源、frontend-static fallback、[`dsh-client-hmr`](../../client/hmr/README.md)、浏览器信任、`web-startup`，以及本包的 `web-runtime` 粘合（`{printUrl, surfaceContext, trustedHosts}`）。运行时通过 `@deepseek-ai/dsh-web-frontend` 解析已构建前端 dist，只采样一次依赖 bind 的 LAN 信任信息并提供给信任栅栏；当 `surfaceContext` 为 true 时注册 Harness 源码与 Web 表层提示词段落及 `DSH_WEB_URL`，并且只在 Loader tree 结算后打印 `dsh web:` URL。`web-startup` 解析 `--host`、`--port`、可重复的 `--trusted-host` 和 `--help`；它会在任何 server 绑定前拒绝 `--host 0.0.0.0`。Desktop profile 不挂载本组合包。

## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到的内容

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（顺序 −98）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

- **前端 dist 必须已构建**：对 dist 的 `require.resolve` 在激活时明确报错并给出构建提示；没有从源码直接服务的回退路径。
- **`lanAddresses` 是启动期快照**：启动后的网卡变化不会重新公告；打印的 LAN URL 始终与配置的信任栅栏一致。
