/**
 * Aggregate live Agent activity drives one isolated Desktop game window.
 * Human approvals pause play immediately; complete idleness leaves an
 * attention overlay until the operator returns to the main application.
 * @module @deepseek-ai/dsh-game-companion
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { GameId } from '@deepseek-ai/dsh-game'
import type { GameDescriptor } from '@deepseek-ai/dsh-game'
import type { DesktopGameCompanion } from '@deepseek-ai/dsh-host-desktop-native'
import type {} from '@deepseek-ai/dsh-user-approval'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'game-companion'
/** Live activity, game catalog, and Rust-owned Desktop window capability. */
export const inject = ['agents', 'desktopNative', 'games']

/** Exclusive Desktop companion selection. */
export type CompanionMode = 'off' | 'bilibili' | 'game'
const COMPANION_SETTINGS_NAMESPACE = settingsNamespace('companion')
interface CompanionSettings { mode?: CompanionMode }
const CompanionSettingsSchema: z<CompanionSettings> = z.object({
  mode: z.union(['off', 'bilibili', 'game'] as CompanionMode[]).default('off'),
})

/** Selected game and bounded native-request configuration. */
export interface Config {
  /** Exclusive companion selected for this Desktop Host. */
  mode?: CompanionMode
  /** Stable id of the game Provider to present. */
  gameId?: string
  /** Bilibili page opened by the media companion. */
  videoUrl?: string
  /** Maximum duration of each native window reconciliation request. */
  nativeTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

/** Schemastery validation and defaults for {@link Config}. */
export const Config: z<Config> = z.object({
  mode: z.union(['off', 'bilibili', 'game'] as CompanionMode[]).default('off'),
  gameId: z.string().default('2048'),
  videoUrl: z.string().default('https://www.bilibili.com/video/BV1GJ411x7h7'),
  nativeTimeoutMs: z.number().default(5_000),
})

function validateConfig(config: ResolvedConfig): void {
  if (!GAME_ID.test(config.gameId)) {
    throw new TypeError(`game-companion: gameId must be lowercase kebab-case, got ${JSON.stringify(config.gameId)}`)
  }
  let videoUrl: URL
  try {
    videoUrl = new URL(config.videoUrl)
  } catch {
    throw new TypeError(`game-companion: videoUrl must be an absolute URL, got ${JSON.stringify(config.videoUrl)}`)
  }
  const host = videoUrl.hostname.toLowerCase()
  if (videoUrl.protocol !== 'https:' || videoUrl.username !== '' || videoUrl.password !== ''
    || !(host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv')) {
    throw new TypeError('game-companion: videoUrl must be credential-free HTTPS on bilibili.com or b23.tv')
  }
  if (!Number.isSafeInteger(config.nativeTimeoutMs) || config.nativeTimeoutMs <= 0) {
    throw new TypeError(`game-companion: nativeTimeoutMs must be a positive safe integer, got ${String(config.nativeTimeoutMs)}`)
  }
}

/** Bounded best-effort media intent; failures never reject Agent work. */
class MediaCoordinator {
  private applied: boolean | undefined
  private chain = Promise.resolve()

  constructor(private readonly ctx: Context, private readonly url: string, private readonly timeoutMs: number) {}

  set(active: boolean): void {
    if (this.applied === active) return
    this.applied = active
    this.chain = this.chain.then(async () => {
      try {
        await this.ctx.desktopNative.setMediaCompanion(
          { url: this.url, active },
          AbortSignal.timeout(this.timeoutMs),
        )
      } catch (error: unknown) {
        this.ctx.logger.warn(`game-companion native media state change failed: ${messageOf(error)}`)
      }
    })
  }

  async dispose(): Promise<void> {
    this.set(false)
    await this.chain
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sameIntent(left: DesktopGameCompanion | undefined, right: DesktopGameCompanion): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Serializes native requests while retaining only the newest complete intent. */
class GameWindowCoordinator {
  private desired: DesktopGameCompanion | undefined
  private applied: DesktopGameCompanion | undefined
  private drain: Promise<void> | undefined
  private disposed = false
  private failed: DesktopGameCompanion | undefined

  constructor(private readonly ctx: Context, private readonly timeoutMs: number) {}

  set(intent: DesktopGameCompanion): void {
    /* v8 ignore next -- Cordis removes listeners before the async disposer marks this private coordinator disposed. */
    if (this.disposed) return
    this.desired = intent
    this.drain ??= Promise.resolve().then(async () => {
      while (!this.disposed && this.desired !== undefined && !sameIntent(this.applied, this.desired)) {
        const next = this.desired
        try {
          await this.ctx.desktopNative.setGameCompanion(next, AbortSignal.timeout(this.timeoutMs))
          this.applied = next
          this.failed = undefined
        } catch (error: unknown) {
          this.failed = next
          this.ctx.logger.warn(`game-companion native window state change failed: ${messageOf(error)}`)
          return
        }
      }
    }).finally(() => {
      this.drain = undefined
      if (!this.disposed && this.desired !== undefined && !sameIntent(this.applied, this.desired)
        && !sameIntent(this.failed, this.desired)) this.set(this.desired)
    })
  }

  async dispose(fallback: GameDescriptor | undefined): Promise<void> {
    /* v8 ignore next -- Cordis effects are single-shot; this guard protects direct repeated cleanup only. */
    if (this.disposed) return
    this.disposed = true
    await this.drain
    const source = fallback === undefined
      ? this.applied
      : { url: fallback.url, title: fallback.title }
    if (source === undefined) return
    await this.ctx.desktopNative.setGameCompanion({
      url: source.url,
      title: source.title,
      mode: 'hidden',
      activeAgentCount: 0,
    }, AbortSignal.timeout(this.timeoutMs))
  }
}

/** Register Desktop game presentation for the lifetime of the Host plugin. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  validateConfig(resolved)
  const gameId = GameId(resolved.gameId)
  const coordinator = new GameWindowCoordinator(ctx, resolved.nativeTimeoutMs)
  const media = new MediaCoordinator(ctx, resolved.videoUrl, resolved.nativeTimeoutMs)
  const running = new Set<Agent>(ctx.agents.list().filter(agent => agent.status === 'running'))
  const approvals = new Set<object>()
  let activated = running.size > 0
  let descriptor: GameDescriptor | undefined
  let missingReported = false
  let selection = resolved.mode
  let settingsSource = (): CompanionSettings => ({ mode: resolved.mode })

  const reconcile = (): void => {
    if (selection !== 'game') {
      media.set(selection === 'bilibili' && running.size > 0 && approvals.size === 0)
      return
    }
    media.set(false)
    const current = ctx.games.get(gameId)
    if (current === undefined) {
      if (descriptor !== undefined) {
        coordinator.set({ url: descriptor.url, title: descriptor.title, mode: 'hidden', activeAgentCount: 0 })
      }
      descriptor = undefined
      if (!missingReported) {
        missingReported = true
        ctx.logger.warn(`game-companion selected game ${JSON.stringify(gameId)} is not registered`)
      }
      return
    }
    descriptor = current
    missingReported = false
    const activeAgentCount = running.size
    const intent: DesktopGameCompanion = approvals.size > 0
      ? { url: current.url, title: current.title, mode: 'attention', reason: 'approval', activeAgentCount }
      : activeAgentCount > 0
        ? { url: current.url, title: current.title, mode: 'playable', activeAgentCount }
        : activated
          ? { url: current.url, title: current.title, mode: 'attention', reason: 'work-complete', activeAgentCount: 0 }
          : { url: current.url, title: current.title, mode: 'hidden', activeAgentCount: 0 }
    coordinator.set(intent)
  }

  ctx.on('games/change', ({ id }) => { if (id === gameId) reconcile() })
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') {
      running.add(agent)
      activated = true
    } else {
      running.delete(agent)
    }
    reconcile()
  }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => {
    running.delete(agent)
    reconcile()
  }, { global: true })
  ctx.on('approval/request', async (request, next) => {
    approvals.add(request)
    reconcile()
    try {
      return await next()
    } finally {
      approvals.delete(request)
      reconcile()
    }
  }, { global: true })
  ctx.effect(() => async () => {
    await coordinator.dispose(descriptor)
    await media.dispose()
  }, 'game-companion: native window lifecycle')
  installSettingsSection(ctx, COMPANION_SETTINGS_NAMESPACE, CompanionSettingsSchema, { mode: resolved.mode }, {
    setSource: (source) => { settingsSource = source },
    onChange: () => {
      selection = settingsSource().mode as CompanionMode
      reconcile()
    },
  })
  reconcile()
}
