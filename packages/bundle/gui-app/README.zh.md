# `@deepseek-ai/dsh-gui-app`

[English](README.md) | 中文

共享图形应用组合。其 patch 添加 Web 与 Desktop 共用的传输无关 Host 服务、客户端模块注册表、Connection 服务、客户端插件清单与按会话 agent preset 布局。它不会打开监听套接字。`dsh-web-app` 添加 HTTP/WebSocket 传输；`dsh-desktop-app` 添加 Desktop 原生提供方选择。

## 模型体验

通过这个共享图形 patch carrier 插入的 Host 行和 agent preset 间接产生影响。

#### KV Cache 影响

该组合包自身不添加文本；缓存行为属于插入的行与选定的 preset。

## 已知限制与暂缓事项

- 客户端包仍声明 `platform: web`；该值目前表示共享 WebView 客户端运行时，将另行重命名。
