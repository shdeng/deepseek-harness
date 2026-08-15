# `@deepseek-ai/dsh-desktop-app`

[English](README.md) | 中文

在 `dsh-gui-app` 之后应用的 Desktop 专属 profile 层。它选择 Tauri 部署需要的原生 Host 提供方，并且有意不包含 Web Server、HTTP 路由、WebSocket、前端静态服务或 HMR 行。应用资产与动态客户端包通过 Tauri 应用／自定义协议传输；产品 RPC 通过 Rust–Node 私有协议传输。

## 模型体验

无，因为这个 Desktop patch carrier 只选择原生 GUI provider，不注册模型可见内容。

#### KV Cache 影响

无；选定的 provider 不组装或发送模型请求。

## 已知限制与暂缓事项

- 目录选择器仍使用 Node 原生提供方。把该提供方的实现迁移到 Rust 壳层之后仍需作为独立的原生能力工作完成。
