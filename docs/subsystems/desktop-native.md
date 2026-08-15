# Desktop Native Capabilities

English | [中文](desktop-native.zh.md)

[`@deepseek-ai/dsh-host-desktop-native`](../../packages/host/desktop-native) defines `ctx.desktopNative`, the Host-facing interface to operations owned by the supervised Tauri shell. The Desktop bundle mounts Consumers and Providers around this interface; ordinary Web and headless profiles do not mount it. Node remains responsible for profile composition, product policy, session behavior, filesystem access, and subprocess streaming.

The private `DSH-IPC/1` channel is bidirectional. Node sends bounded native requests for directory selection, controlled HTTP(S) opening, notifications, application metadata, and secure credential capture. Rust sends accepted `deepseek-harness://session/<session-id>` links back as `desktopNative/deep-link`. Both sides validate operation-specific fields and correlate request ids; no operation accepts an arbitrary command name or local path to execute.

Desktop credentials use [`ctx.credentials`](credentials.md) with a system-vault Provider. Rust captures and stores secret text through Windows Credential Manager, macOS Keychain, or Linux Secret Service. WebView and stdio messages carry only a [`CredentialRef`](credentials.md); Node resolves the value through the packaged same-process Rust library when an LLM adapter needs it. The shell rejects plaintext credential RPC before forwarding it to Node.

The main-window Tauri ACL contains event listening and the three application RPC commands. It grants no dialog, opener, notification, credential, metadata, or deep-link plugin command to the WebView. External anchors and task-completion notifications therefore call Host Remote methods, which reach Rust only through `ctx.desktopNative`.

Design record: [Tauri desktop shell Agent Note](../../.agents/notes/proposed/architecture/2026-08-14-tauri-desktop-shell.md).

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
 * Read metadata from the running desktop package.
 * @param signal - caller lifetime.
 * @returns metadata owned by the Rust application package.
 */
abstract metadata(signal: AbortSignal): Promise<DesktopApplicationMetadata>
```

Types: [CredentialRef](credentials.md)

Source: [`packages/host/desktop-native/src/index.ts:44`](../../packages/host/desktop-native/src/index.ts)

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

Source: [`packages/host/desktop-native/src/index.ts:36`](../../packages/host/desktop-native/src/index.ts)
<!-- END GENERATED cordis-surface -->
