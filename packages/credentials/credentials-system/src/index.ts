/**
 * Desktop credential Provider backed by the operating system vault. The
 * WebView and framed stdio carry only CredentialRef handles. Native secure
 * input and storage run in Rust; resolution enters Node through a same-process
 * Rust dynamic library instead of the sidecar pipe.
 * @module @deepseek-ai/dsh-credentials-system
 */

import { Buffer } from 'node:buffer'
import koffi from 'koffi'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialInputMode, CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-desktop-native'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'

const LIBRARY_ENV = 'DSH_DESKTOP_CREDENTIAL_LIBRARY'
const BUFFER_BYTES = 64 * 1024

type ReadFunction = (reference: string, output: Buffer, capacity: number) => number
type HandleFunction = (reference: string) => number
type ErrorFunction = (output: Buffer, capacity: number) => number

interface CredentialLibrary {
  get: ReadFunction
  status: HandleFunction
  delete: HandleFunction
  lastError: ErrorFunction
}

/**
 * Load the Rust credential ABI from an absolute desktop resource path.
 * @param path Absolute path to the packaged dynamic library.
 * @returns Bound credential-library functions.
 */
export function loadCredentialLibrary(path: string): CredentialLibrary {
  const library = koffi.load(path)
  return {
    get: library.func('intptr dsh_credential_get(const char *reference, void *output, size_t capacity)') as ReadFunction,
    status: library.func('intptr dsh_credential_status(const char *reference)') as HandleFunction,
    delete: library.func('intptr dsh_credential_delete(const char *reference)') as HandleFunction,
    lastError: library.func('intptr dsh_credential_last_error(void *output, size_t capacity)') as ErrorFunction,
  }
}

function failure(library: CredentialLibrary): Error {
  const output = Buffer.alloc(BUFFER_BYTES)
  const length = library.lastError(output, output.length)
  const message = length >= 0 ? output.toString('utf8', 0, length) : 'Rust credential provider failed'
  output.fill(0)
  return new Error(message)
}

/** System-vault implementation of `ctx.credentials` for the desktop profile. */
export default class SystemCredentialProvider extends CredentialProvider {
  /** The Rust shell service owns secure input. */
  static inject = ['desktopNative']

  private readonly library: CredentialLibrary

  constructor(ctx: ConstructorParameters<typeof CredentialProvider>[0]) {
    super(ctx)
    const path = process.env[LIBRARY_ENV]
    if (path === undefined || path.length === 0) {
      throw new Error(`${LIBRARY_ENV} is required by the desktop credential provider`)
    }
    this.library = loadCredentialLibrary(path)
  }

  override inputMode(): CredentialInputMode {
    return 'native'
  }

  override resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const inherited = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    if (inherited !== undefined && inherited.value.length > 0) {
      return Promise.resolve({ value: inherited.value, source: 'env' })
    }
    const output = Buffer.alloc(BUFFER_BYTES)
    const length = this.library.get(ref, output, output.length)
    if (length === -1) return Promise.resolve(undefined)
    if (length < 0) return Promise.reject(failure(this.library))
    const value = output.toString('utf8', 0, length)
    output.fill(0)
    return Promise.resolve({ value, source: 'system' })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    const inherited = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    if (inherited !== undefined && inherited.value.length > 0) {
      return Promise.resolve({ configured: true, source: 'env', writable: false })
    }
    const status = this.library.status(ref)
    if (status < 0) return Promise.reject(failure(this.library))
    return Promise.resolve({
      configured: status === 1,
      ...(status === 1 ? { source: 'system' } : {}),
      writable: true,
    })
  }

  override set(ref: CredentialRef, value: string): Promise<void> {
    void ref
    void value
    return Promise.reject(new Error('desktop credentials must be entered through native secure input'))
  }

  override async capture(ref: CredentialRef, signal: AbortSignal): Promise<boolean> {
    const stored = await this.ctx.desktopNative.captureCredential(ref, signal)
    if (stored) this.notifyUpdated(ref)
    return stored
  }

  override unset(ref: CredentialRef): Promise<void> {
    const inherited = launchEnvironmentOf(this.ctx).getFrom(ref, ['process'])
    if (inherited !== undefined && inherited.value.length > 0) {
      return Promise.reject(new Error(`credential "${ref}" is supplied read-only by the launching environment`))
    }
    const result = this.library.delete(ref)
    if (result < 0) return Promise.reject(failure(this.library))
    this.notifyUpdated(ref)
    return Promise.resolve()
  }
}
