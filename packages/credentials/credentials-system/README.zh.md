# @deepseek-ai/dsh-credentials-system

[English](README.md) | 中文

这是 [`ctx.credentials`](../credentials/README.md) 的 Desktop Provider，通过 Rust `keyring` crate 使用 Windows Credential Manager、macOS Keychain 或 Linux Secret Service。继承的启动环境仍是只读、最高优先级层。所有可写值都以不透明 `CredentialRef` 作为 account name，存入服务名为 `ai.deepseek.harness.desktop` 的操作系统凭据库。

Desktop profile 中的 WebView 不会渲染或提交密码输入框，而是调用 `credentials.capture({ ref })`；Rust 打开安全输入对话框，并把值直接写入系统凭据库。Rust–Node 分帧 stdio 只携带引用和已存储／已取消结果。Node 在提供方调用时通过 Koffi 加载打包的 Rust 动态库来解析值，避免明文进入 stdio。Desktop 传输会在进入 Node 管道前拒绝 `credentials.set`，也会拒绝携带 `apiKey` 的模型发现 payload。

## 模型体验

仅通过使用已解析凭据完成授权的 LLM adapter 间接产生影响。凭据值不会对模型可见。

#### KV Cache 影响

无；凭据属于请求授权数据，不属于 prompt 前缀内容。

## 已知限制与暂缓事项

- Windows 的完整操作系统应用身份要求已安装应用；开发构建的通知可能显示平台工具身份。
- Linux 需要正在运行的 Secret Service 实现以及已解锁的 collection。
