/**
 * Opt-in Bilibili companion: aggregate live-agent activity drives one
 * isolated Tauri WebView through `ctx.desktopNative`. Running shows, focuses,
 * and plays; complete idleness pauses and hides.
 * @module @deepseek-ai/dsh-bilibili-companion
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-desktop-native'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'bilibili-companion'

/** Live-agent activity plus the Rust-owned desktop window capability. */
export const inject = ['agents', 'desktopNative']

/** Bilibili page and bounded native-request configuration. */
export interface Config {
  /** Bilibili page opened when Rust first creates the companion window. */
  videoUrl?: string
  /** Maximum duration of each native window reconciliation request. */
  nativeTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  videoUrl: z.string().default('https://www.bilibili.com/video/BV1GJ411x7h7'),
  nativeTimeoutMs: z.number().default(5_000),
})

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function validateConfig(config: ResolvedConfig): void {
  let url: URL
  try {
    url = new URL(config.videoUrl)
  } catch {
    throw new TypeError(`bilibili-companion: videoUrl must be an absolute URL, got ${JSON.stringify(config.videoUrl)}`)
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || !(host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv')) {
    throw new TypeError(`bilibili-companion: videoUrl must be credential-free HTTPS on bilibili.com or b23.tv, got ${JSON.stringify(config.videoUrl)}`)
  }
  if (!Number.isSafeInteger(config.nativeTimeoutMs) || config.nativeTimeoutMs <= 0) {
    throw new TypeError(`bilibili-companion: nativeTimeoutMs must be a positive safe integer, got ${String(config.nativeTimeoutMs)}`)
  }
}

/** Bounded adapter over the Desktop-native media operation. */
class NativeMediaController {
  constructor(
    private readonly ctx: Context,
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async setActive(active: boolean): Promise<void> {
    await this.ctx.desktopNative.setMediaCompanion(
      { url: this.url, active },
      AbortSignal.timeout(this.timeoutMs),
    )
  }

  async dispose(): Promise<void> {
    await this.setActive(false)
  }
}

/** Serializes latest-state reconciliation and contains native-window failures. */
class ActivityCoordinator {
  private desired = false
  private applied: boolean | undefined
  private drain: Promise<void> | undefined
  private disposed = false
  private failedFor: boolean | undefined

  constructor(
    private readonly media: NativeMediaController,
    private readonly ctx: Context,
  ) {}

  setActive(active: boolean): void {
    /* v8 ignore next -- Cordis removes status listeners before the async disposer marks the coordinator disposed. */
    if (this.disposed) return
    this.desired = active
    this.drain ??= Promise.resolve().then(async () => {
      while (!this.disposed && this.applied !== this.desired) {
        const next = this.desired
        try {
          await this.media.setActive(next)
          this.applied = next
          this.failedFor = undefined
        } catch (error: unknown) {
          this.failedFor = next
          this.ctx.logger.warn(`bilibili-companion native window state change failed: ${messageOf(error)}`)
          return
        }
      }
    }).finally(() => {
      this.drain = undefined
      if (!this.disposed && this.applied !== this.desired && this.failedFor !== this.desired) {
        this.setActive(this.desired)
      }
    })
  }

  async dispose(): Promise<void> {
    /* v8 ignore next -- Cordis effects are single-shot; the guard protects direct repeated cleanup calls. */
    if (this.disposed) return
    this.disposed = true
    await this.drain
    await this.media.dispose()
  }
}

/**
 * Register aggregate agent-activity playback for the lifetime of `ctx`.
 * @param ctx - plugin context carrying agent and Desktop-native services.
 * @param config - Bilibili URL and native request timeout.
 * @throws at load for an unauthorized URL or invalid timeout.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  validateConfig(resolved)
  const media = new NativeMediaController(ctx, resolved.videoUrl, resolved.nativeTimeoutMs)
  const coordinator = new ActivityCoordinator(media, ctx)
  const running = new Set<Agent>(ctx.agents.list().filter(agent => agent.status === 'running'))
  const reconcile = (): void => { coordinator.setActive(running.size > 0) }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') running.add(agent)
    else running.delete(agent)
    reconcile()
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    running.delete(agent)
    reconcile()
  }, { global: true })
  ctx.effect(() => () => coordinator.dispose(), 'bilibili-companion: native window lifecycle')
  reconcile()
}
