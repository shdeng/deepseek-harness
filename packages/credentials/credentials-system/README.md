# @deepseek-ai/dsh-credentials-system

English | [中文](README.zh.md)

Desktop Provider of [`ctx.credentials`](../credentials/README.md), backed by Windows Credential Manager, macOS Keychain, or Linux Secret Service through the Rust `keyring` crate. The inherited launch environment remains a read-only highest-precedence layer. All writable values use the operating-system vault under service `ai.deepseek.harness.desktop` and an opaque `CredentialRef` account name.

The WebView never renders or submits a password input in the Desktop profile. It asks `credentials.capture({ ref })`; Rust opens the secure input dialog and writes the value directly to the vault. Framed Rust–Node stdio carries only the reference and a stored/cancelled outcome. Node resolves a value for provider calls through the packaged Rust dynamic library loaded by Koffi, avoiding plaintext on stdio. Desktop carriage rejects `credentials.set` and model-discovery payloads containing `apiKey` before the Node pipe.

## Model Experience

Indirectly, through LLM adapters authorized by a resolved credential. Credential values are not model-visible.

#### KV Cache effect

None; credentials are request authorization data, not prompt-prefix content.

## Known Limitations and Deferred Work

- Windows notifications and credentials require an installed application for the full operating-system identity; development builds may show platform tool identity.
- Linux requires a running Secret Service implementation and an unlocked collection.
