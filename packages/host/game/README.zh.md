# @deepseek-ai/dsh-game

[English](README.md) | 中文

这个 Service Definition 与注册表持有 `ctx.games`。本地 Provider 以稳定的 kebab-case 游戏 id 注册有界 UTF-8 HTML、CSS 与 JavaScript 资产。Consumer 得到 `dsh-game://localhost/<sha256>/index.html` 入口 URL，但不会得到 Provider 的文件系统路径。

## Provider 注册

```ts ignore-check
ctx.games.register({
  id: GameId('example'),
  title: 'Example',
  assets: [
    { path: 'index.html', contentType: 'text/html; charset=utf-8', body: html },
    { path: 'game.js', contentType: 'text/javascript; charset=utf-8', body: script },
  ],
})
```

注册属于 effect：释放 Provider 会移除其 id，并让新的资产请求无法读取该摘要。每个资产最多 512 KiB，每个游戏最多 2 MiB。路径必须是规范化的小写相对文本；封闭的媒体类型只包含 UTF-8 HTML、CSS 与 JavaScript。注册或移除提交后，注册表会发出 `games/change`。

私有 Desktop sidecar 按摘要与路径读取资产。注册表不提供文件服务器、网络路由、模型工具或任意本地路径。

## Model Experience

None, as this registry serves only human-played Desktop companion content.

#### KV Cache effect

无；游戏注册与资产读取从不组装模型请求。

## Known Limitations and Deferred Work

- **只支持文本资产** —— Provider 不能注册图片、音频、WebAssembly 或其他二进制资产；必须使用 CSS 与自包含 UTF-8 资源。
- **只有 Desktop 传输** —— 随产品提供的 Consumer 使用 Tauri 自定义协议；Web 与 headless profile 可以挂载注册表，但没有展示 Provider。
