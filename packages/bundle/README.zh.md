# bundle/ — profile 插件组合包

[English](README.md) | 中文

Profile 组合包：在 manifest（元数据清单）中声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 的 npm 包，因此可作为 patch 层安装进 `dsh --profile` 组合（[profile 约定](../boot/app-boot/README.md#profiles)）。组合包的实体是它的 patch 列表；有些组合包还附带由其 patch 挂载的运行时粘合插件。

| 包 | 职责 | ctx key |
|---|---|---|
| [`base/`](base/README.md) | 每个 profile 最先应用的共享 dsh 核心 | —（仅 patch） |
| [`llm-multi-provider/`](llm-multi-provider/README.md) | 为多 provider profile 提供可选 pi-ai route | —（仅 patch） |
| [`gui-app/`](gui-app/README.md) | 共享图形 Host 与客户端组合；不打开网络监听器 | —（仅 patch） |
| [`web-app/`](web-app/README.md) | 浏览器传输：HTTP／WebSocket／静态资源／HMR 行与运行时粘合 | 挂载多条配置行 |
| [`desktop-app/`](desktop-app/README.md) | Desktop 专属原生 provider 选择；不含 Web 传输 | —（仅 patch） |
| [`headless/`](headless/README.md) | 直接运行在 base 之上的一次性任务模式，不含 Host 或 Web 层 | 挂载 `headless-runner` |

内置组合包从 dsh 安装目录解析；树外（out-of-tree）组合包通过 `dsh plugin --profile <name> add <package>` 安装进 profile。
