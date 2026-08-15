# @deepseek-ai/dsh-host-directory-picker-desktop

[English](README.md) | 中文

这是 [`ctx.directoryPicker`](../directory-picker/README.md) 能力 seam 的 Desktop Provider。它既消费 `ctx.desktopNative.pickDirectory()`，也提供该 seam 稳定的 `{ kind: 'native', pick(signal) }` 能力。Desktop profile 将本 package 与现有原生客户端流程一起挂载，因此工作区选择仍经由 `host.pickDirectory`；不再保留 WebView picker command。

## 模型体验

无影响，因为该 package 只适配操作者的目录选择。

#### KV Cache 影响

无。

## 已知限制与暂缓事项

- 产品目前只消费单目录选择器。只有在 Service Definition 与 Consumer 词汇同时明确后，才应加入文件选择器。
