# 桌面原生能力

[English](desktop-native.md) | 中文

[`@deepseek-ai/dsh-host-desktop-native`](../../packages/host/desktop-native) 定义了 `ctx.desktopNative`，即 Host 访问受监督 Tauri 壳层所持操作的接口。Desktop 组合包围绕该接口挂载 Consumer 与 Provider；普通 Web 和 headless profile 不挂载它。Node 继续负责 profile 组合、产品策略、会话行为、文件系统访问和 subprocess 流式执行。

私有 `DSH-IPC/1` 通道是双向的。Node 为目录选择、受控 HTTP(S) 打开、通知、应用元数据、安全凭据采集和 B 站媒体伴随窗口发送有界原生请求。Rust 把已接受的 `deepseek-harness://session/<session-id>` 链接作为 `desktopNative/deep-link` 发回。双方均校验各操作的字段并关联请求 id；任何操作都不接受任意 command 名称、脚本、窗口标签或待执行的本地路径。

Desktop 凭据通过 [`ctx.credentials`](credentials.md) 使用系统凭据库 Provider。Rust 通过 Windows Credential Manager、macOS Keychain 或 Linux Secret Service 采集并存储 secret 文本。WebView 与 stdio 消息只携带 [`CredentialRef`](credentials.md)；LLM adapter 需要凭据时，Node 通过打包的同进程 Rust 库解析其值。壳层会在明文凭据 RPC 转发给 Node 之前拒绝它。

主窗口 Tauri ACL 只包含事件监听和三个应用 RPC command，不向 WebView 授予 dialog、opener、notification、credential、metadata 或 deep-link 插件 command。独立的 B 站窗口标签不属于任何 capability，因此其中的远程内容没有 Harness IPC 权限。外链 anchor、任务完成通知和媒体活动意图都只能通过 `ctx.desktopNative` 到达 Rust。

设计记录：[Tauri 桌面壳 Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdesktopnative--desktopnative-abstract-seam"></a>

### `ctx.desktopNative` — `DesktopNative` (abstract seam)

Native desktop operations that the Rust shell provides to the Node Host.

```ts cordis-catalog
/**
 * Open the operating system directory chooser.
 * @param signal - caller lifetime; an aborted call discards any later chooser result.
 * @returns the selected absolute path, or null when the operator cancels.
 */
abstract pickDirectory(signal: AbortSignal): Promise<string | null>

/**
 * Prompt outside the WebView for a credential and store it in the operating system vault.
 * @param ref - opaque credential handle used as the vault account name.
 * @param signal - caller lifetime; abort discards any later prompt result.
 * @returns true when a value was stored, or false when the operator cancels.
 */
abstract captureCredential(ref: CredentialRef, signal: AbortSignal): Promise<boolean>

/**
 * Open one operator-visible web URL after Rust applies the desktop URL policy.
 * @param url - absolute http or https URL without embedded credentials.
 * @param signal - caller lifetime.
 */
abstract openExternal(url: string, signal: AbortSignal): Promise<void>

/**
 * Send one native operating-system notification.
 * @param notification - bounded plain-text title and body.
 * @param signal - caller lifetime.
 */
abstract notify(notification: DesktopNotification, signal: AbortSignal): Promise<void>

/**
 * Reconcile the isolated Bilibili WebView window with one activity state.
 * @param companion - configured Bilibili URL and the complete desired visibility/playback state.
 * @param signal - caller lifetime; abort discards any later completion.
 */
abstract setMediaCompanion(companion: DesktopMediaCompanion, signal: AbortSignal): Promise<void>

/**
 * Read metadata from the running desktop package.
 * @param signal - caller lifetime.
 * @returns metadata owned by the Rust application package.
 */
abstract metadata(signal: AbortSignal): Promise<DesktopApplicationMetadata>
```

Types: [CredentialRef](credentials.md)

Source: [`packages/host/desktop-native/src/index.ts:52`](../../packages/host/desktop-native/src/index.ts)

<a id="desktopnative-events"></a>

### `desktopNative/*` events

<a id="desktopnativedeep-link--emit"></a>

#### `desktopNative/deep-link` — emit

The Rust shell accepted a registered application deep link.

```ts cordis-catalog
/**
 * The Rust shell accepted a registered application deep link.
 * @mode emit
 * @param sessionId - opaque session selected by the deep link.
 */
'desktopNative/deep-link'(sessionId: string): void
```

Source: [`packages/host/desktop-native/src/index.ts:44`](../../packages/host/desktop-native/src/index.ts)
<!-- END GENERATED cordis-surface -->
