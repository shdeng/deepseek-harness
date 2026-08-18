/** REAL composition boots the registry, 2048 Provider, and companion through Loader. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import GameRegistry from '@deepseek-ai/dsh-game'
import DesktopNative from '@deepseek-ai/dsh-host-desktop-native'
import type {
  DesktopApplicationMetadata, DesktopGameCompanion, DesktopMediaCompanion, DesktopNotification,
} from '@deepseek-ai/dsh-host-desktop-native'
import * as game2048 from '@deepseek-ai/dsh-game-2048'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as companion from '../src/index.ts'

class FakeDesktopNative extends DesktopNative {
  readonly games: DesktopGameCompanion[] = []
  readonly media: DesktopMediaCompanion[] = []
  failureOnce: Error | string | undefined
  mediaFailureOnce: Error | undefined
  private deferred: PromiseWithResolvers<undefined> | undefined

  deferNext(): PromiseWithResolvers<undefined> {
    this.deferred = Promise.withResolvers<undefined>()
    return this.deferred
  }

  override pickDirectory(): Promise<string | null> { return Promise.resolve(null) }
  override captureCredential(): Promise<boolean> { return Promise.resolve(false) }
  override openExternal(): Promise<void> { return Promise.resolve() }
  override notify(_notification: DesktopNotification): Promise<void> { return Promise.resolve() }
  override setMediaCompanion(companion: DesktopMediaCompanion): Promise<void> {
    this.media.push(structuredClone(companion))
    if (this.mediaFailureOnce !== undefined) {
      const failure = this.mediaFailureOnce
      this.mediaFailureOnce = undefined
      return Promise.reject(failure)
    }
    return Promise.resolve()
  }
  override setGameCompanion(game: DesktopGameCompanion, signal: AbortSignal): Promise<void> {
    this.games.push(structuredClone(game))
    if (this.failureOnce !== undefined) {
      const failure = this.failureOnce
      this.failureOnce = undefined
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises the coordinator's unknown-rejection containment.
      return Promise.reject(failure)
    }
    const deferred = this.deferred
    if (deferred !== undefined) {
      this.deferred = undefined
      const abort = (): void => { deferred.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted')) }
      signal.addEventListener('abort', abort, { once: true })
      return deferred.promise.finally(() => { signal.removeEventListener('abort', abort) })
    }
    return Promise.resolve()
  }
  override metadata(): Promise<DesktopApplicationMetadata> {
    return Promise.resolve({ name: 'test', version: '1', identifier: 'test' })
  }
}

class FakeSettings extends Service {
  mode: 'off' | 'bilibili' | 'game' = 'game'
  private readonly watchers = new Set<() => void>()
  constructor(ctx: Context) { super(ctx, 'settings') }
  register(): never {
    return {
      get: () => ({ mode: this.mode }),
      watch: (listener: () => void) => {
        this.watchers.add(listener)
        return () => { this.watchers.delete(listener) }
      },
    } as never
  }
  select(mode: 'off' | 'bilibili' | 'game'): void {
    this.mode = mode
    for (const watcher of this.watchers) watcher()
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for native game intent')
}

async function loadComposition(): Promise<{ ctx: Context; desktop: FakeDesktopNative }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-game-companion-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-game'",
    "- name: '@deepseek-ai/dsh-game-2048'",
    "- name: 'test:desktop-native'",
    "- name: '@deepseek-ai/dsh-game-companion'",
    '  config:',
    "    mode: 'game'",
    "    gameId: '2048'",
    '    nativeTimeoutMs: 1000',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-game', GameRegistry],
    ['@deepseek-ai/dsh-game-2048', game2048],
    ['test:desktop-native', FakeDesktopNative],
    ['@deepseek-ai/dsh-game-companion', companion],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, desktop: ctx.desktopNative as FakeDesktopNative }
}

function fakeAgent(): Agent { return {} as Agent }

function registerSample(ctx: Context, id = '2048'): () => void {
  return ctx.games.register({
    id: id as never,
    title: id,
    assets: [{ path: 'index.html', contentType: 'text/html; charset=utf-8', body: '<!doctype html>' }],
  })
}

describe('game companion real Loader composition', () => {
  it('moves from hidden through playable to completion attention and hides on disposal', async () => {
    const { ctx, desktop } = await loadComposition()
    await waitFor(() => desktop.games.length === 1)
    expect(desktop.games[0]).toMatchObject({ title: '2048', mode: 'hidden', activeAgentCount: 0 })
    expect(desktop.games[0]?.url).toMatch(/^dsh-game:\/\/localhost\/[a-f0-9]{64}\/index\.html$/)

    const first = fakeAgent()
    const second = fakeAgent()
    agentEvents(ctx, first).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')
    agentEvents(ctx, second).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.activeAgentCount === 2)
    agentEvents(ctx, first).emit('agent/status', { status: 'idle' })
    agentEvents(ctx, second).emit('agent/disposed', {})
    await waitFor(() => desktop.games.at(-1)?.mode === 'attention')
    expect(desktop.games.at(-1)).toMatchObject({ reason: 'work-complete', activeAgentCount: 0 })

    await ctx.fiber.dispose()
    context = undefined
    expect(desktop.games.at(-1)?.mode).toBe('hidden')
  })

  it('pauses a running game for the lifetime of an approval waterfall', async () => {
    const { ctx, desktop } = await loadComposition()
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')

    const answer = Promise.withResolvers<ApprovalOutcome>()
    const pending = ctx.waterfall(
      'approval/request',
      { agent, toolName: 'bash' },
      () => answer.promise,
    )
    await waitFor(() => desktop.games.at(-1)?.reason === 'approval')
    answer.resolve('allowed-once')
    await pending
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')
  })
})

describe('game companion configuration', () => {
  it.each([
    [{ gameId: 'Bad Id' }, /lowercase kebab-case/],
    [{ videoUrl: 'not a URL' }, /absolute URL/],
    [{ videoUrl: 'http://bilibili.com/video/x' }, /credential-free HTTPS/],
    [{ videoUrl: 'https://user:secret@bilibili.com/video/x' }, /credential-free HTTPS/],
    [{ videoUrl: 'https://example.com/video/x' }, /credential-free HTTPS/],
    [{ nativeTimeoutMs: 0 }, /positive safe integer/],
    [{ nativeTimeoutMs: 1.5 }, /positive safe integer/],
  ] as const)('rejects invalid config %j', async (config, expected) => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    await ctx.plugin(FakeDesktopNative)
    await expect(ctx.plugin(companion, config)).rejects.toThrow(expected)
  })
})

describe('game companion reconciliation edges', () => {
  it('switches the exclusive mode when the persisted setting changes', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    registerSample(ctx)
    await ctx.plugin(FakeDesktopNative)
    await ctx.plugin(FakeSettings)
    await ctx.plugin(companion, { mode: 'off' })
    const desktop = ctx.desktopNative as FakeDesktopNative
    const settings = ctx.settings as unknown as FakeSettings
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')
    settings.select('bilibili')
    await waitFor(() => desktop.media.at(-1)?.active === true)
    settings.select('off')
    await waitFor(() => desktop.media.at(-1)?.active === false)
  })

  it('selects Bilibili exclusively and keeps off mode inactive', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    await ctx.plugin(FakeDesktopNative)
    ;(ctx.desktopNative as FakeDesktopNative).mediaFailureOnce = new Error('media unavailable')
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(companion, { mode: 'bilibili' })
    const desktop = ctx.desktopNative as FakeDesktopNative
    await waitFor(() => desktop.media.length === 1)
    expect(desktop.media[0]?.active).toBe(false)
    await waitFor(() => warn.mock.calls.length === 1)
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.media.at(-1)?.active === true)
    expect(desktop.games).toHaveLength(0)
    await ctx.fiber.dispose()
    context = undefined
    expect(desktop.media.at(-1)?.active).toBe(false)

    const off = new Context()
    await off.plugin(AgentRegistry)
    await off.plugin(GameRegistry)
    await off.plugin(FakeDesktopNative)
    await off.plugin(companion, { mode: 'off' })
    const offDesktop = off.desktopNative as FakeDesktopNative
    await waitFor(() => offDesktop.media.length === 1)
    agentEvents(off, fakeAgent()).emit('agent/status', { status: 'running' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(offDesktop.media).toHaveLength(1)
    expect(offDesktop.games).toHaveLength(0)
    await off.fiber.dispose()
  })

  it.each(['https://bilibili.com/video/x', 'https://b23.tv/x'])('accepts Bilibili host %s', async (videoUrl) => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    await ctx.plugin(FakeDesktopNative)
    await expect(ctx.plugin(companion, { mode: 'off', videoUrl })).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })

  it('starts playable when an Agent is already running at mount time', async () => {
    const existing = { status: 'running' } as Agent
    class ExistingAgentRegistry extends Service {
      constructor(ctx: Context) { super(ctx, 'agents') }
      list(): Agent[] { return [existing] }
    }
    const ctx = new Context()
    context = ctx
    await ctx.plugin(ExistingAgentRegistry)
    await ctx.plugin(GameRegistry)
    registerSample(ctx)
    await ctx.plugin(FakeDesktopNative)
    await ctx.plugin(companion, { mode: 'game' })
    const desktop = ctx.desktopNative as FakeDesktopNative
    await waitFor(() => desktop.games.length === 1)
    expect(desktop.games[0]).toMatchObject({ mode: 'playable', activeAgentCount: 1 })
  })

  it('waits for a missing selected Provider, ignores unrelated changes, and hides a removed game', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    await ctx.plugin(FakeDesktopNative)
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(companion, { mode: 'game' })
    expect(warn).toHaveBeenCalledTimes(1)
    ctx.emit('games/change', { id: '2048' as never, kind: 'removed' })
    expect(warn).toHaveBeenCalledTimes(1)
    registerSample(ctx, 'other')
    const desktop = ctx.desktopNative as FakeDesktopNative
    expect(desktop.games).toHaveLength(0)

    const dispose = registerSample(ctx)
    await waitFor(() => desktop.games.at(-1)?.mode === 'hidden')
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')
    dispose()
    await waitFor(() => desktop.games.at(-1)?.mode === 'hidden')
  })

  it('contains native failures, reconciles newer state, and bounds an unresponsive request', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(GameRegistry)
    registerSample(ctx)
    await ctx.plugin(FakeDesktopNative)
    const desktop = ctx.desktopNative as FakeDesktopNative
    desktop.failureOnce = 'native unavailable'
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(companion, { mode: 'game' })
    await waitFor(() => warn.mock.calls.length === 1)
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.games.at(-1)?.mode === 'playable')

    const newerContext = new Context()
    await newerContext.plugin(AgentRegistry)
    await newerContext.plugin(GameRegistry)
    registerSample(newerContext)
    await newerContext.plugin(FakeDesktopNative)
    const newerDesktop = newerContext.desktopNative as FakeDesktopNative
    const deferred = newerDesktop.deferNext()
    await newerContext.plugin(companion, { mode: 'game' })
    await waitFor(() => newerDesktop.games.length === 1)
    const newerAgent = fakeAgent()
    agentEvents(newerContext, newerAgent).emit('agent/status', { status: 'running' })
    deferred.reject(new Error('old state failed'))
    await waitFor(() => newerDesktop.games.at(-1)?.mode === 'playable')
    await newerContext.fiber.dispose()

    const timeoutContext = new Context()
    await timeoutContext.plugin(AgentRegistry)
    await timeoutContext.plugin(GameRegistry)
    registerSample(timeoutContext)
    await timeoutContext.plugin(FakeDesktopNative)
    const timeoutDesktop = timeoutContext.desktopNative as FakeDesktopNative
    timeoutDesktop.deferNext()
    const timeoutWarn = vi.spyOn(timeoutContext.logger, 'warn')
    await timeoutContext.plugin(companion, { mode: 'game', nativeTimeoutMs: 10 })
    await waitFor(() => timeoutWarn.mock.calls.length === 1)
    await timeoutContext.fiber.dispose()
  })
})
