/** REAL-composition coverage observes native media requests emitted by a Loader-mounted plugin. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import DesktopNative from '@deepseek-ai/dsh-host-desktop-native'
import type {
  DesktopApplicationMetadata, DesktopGameCompanion, DesktopMediaCompanion, DesktopNotification,
} from '@deepseek-ai/dsh-host-desktop-native'
import * as bilibiliCompanion from '../src/index.ts'

class FakeDesktopNative extends DesktopNative {
  readonly media: DesktopMediaCompanion[] = []
  failureOnce: Error | string | undefined
  private deferred: PromiseWithResolvers<undefined> | undefined

  deferNext(): PromiseWithResolvers<undefined> {
    this.deferred = Promise.withResolvers<undefined>()
    return this.deferred
  }

  override pickDirectory(): Promise<string | null> { return Promise.resolve(null) }
  override captureCredential(): Promise<boolean> { return Promise.resolve(false) }
  override openExternal(): Promise<void> { return Promise.resolve() }
  override notify(_notification: DesktopNotification): Promise<void> { return Promise.resolve() }
  override metadata(): Promise<DesktopApplicationMetadata> {
    return Promise.resolve({ name: 'test', version: '1', identifier: 'test' })
  }

  override setMediaCompanion(companion: DesktopMediaCompanion, signal: AbortSignal): Promise<void> {
    this.media.push(structuredClone(companion))
    if (this.failureOnce !== undefined) {
      const failure = this.failureOnce
      this.failureOnce = undefined
      return Promise.reject(failure instanceof Error ? failure : new Error(failure))
    }
    const deferred = this.deferred
    if (deferred !== undefined) {
      this.deferred = undefined
      const abort = (): void => {
        deferred.reject(signal.reason instanceof Error ? signal.reason : new Error('native request aborted'))
      }
      signal.addEventListener('abort', abort, { once: true })
      return deferred.promise.finally(() => { signal.removeEventListener('abort', abort) })
    }
    return Promise.resolve()
  }

  override setGameCompanion(_companion: DesktopGameCompanion): Promise<void> { return Promise.resolve() }
}

interface Mounted {
  ctx: Context
  desktop: FakeDesktopNative
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.restoreAllMocks()
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for native media state')
}

async function mount(config: bilibiliCompanion.Config = {}): Promise<Mounted> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeDesktopNative)
  const desktop = ctx.desktopNative as FakeDesktopNative
  await ctx.plugin(bilibiliCompanion, config)
  return { ctx, desktop }
}

async function loadComposition(): Promise<Mounted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bilibili-native-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: 'test:desktop-native'",
    "- name: '@deepseek-ai/dsh-bilibili-companion'",
    '  config:',
    "    videoUrl: 'https://www.bilibili.com/video/test'",
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
    ['test:desktop-native', FakeDesktopNative],
    ['@deepseek-ai/dsh-bilibili-companion', bilibiliCompanion],
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

describe('Bilibili companion real Loader composition', () => {
  it('maps aggregate agent activity to one Tauri media window and hides it on disposal', async () => {
    const { ctx, desktop } = await loadComposition()
    await waitFor(() => desktop.media.length === 1)
    expect(desktop.media).toEqual([
      { url: 'https://www.bilibili.com/video/test', active: false },
    ])

    const first = fakeAgent()
    const second = fakeAgent()
    agentEvents(ctx, first).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.media.length === 2)
    expect(desktop.media.at(-1)?.active).toBe(true)

    agentEvents(ctx, second).emit('agent/status', { status: 'running' })
    agentEvents(ctx, first).emit('agent/status', { status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(desktop.media).toHaveLength(2)

    agentEvents(ctx, second).emit('agent/disposed', {})
    await waitFor(() => desktop.media.length === 3)
    expect(desktop.media.at(-1)?.active).toBe(false)

    await ctx.fiber.dispose()
    context = undefined
    expect(desktop.media.at(-1)?.active).toBe(false)
    expect(desktop.media.length).toBeGreaterThanOrEqual(4)
  })
})

describe('Bilibili companion configuration', () => {
  it.each([
    [{ videoUrl: 'not a URL' }, /must be an absolute URL/],
    [{ videoUrl: 'http://www.bilibili.com/video/x' }, /credential-free HTTPS/],
    [{ videoUrl: 'https://user:secret@www.bilibili.com/video/x' }, /credential-free HTTPS/],
    [{ videoUrl: 'https://example.com/video/x' }, /credential-free HTTPS/],
    [{ nativeTimeoutMs: 0 }, /positive safe integer/],
    [{ nativeTimeoutMs: 1.5 }, /positive safe integer/],
  ] as const)('rejects invalid config %j', async (config, expected) => {
    await expect(mount(config)).rejects.toThrow(expected)
  })

  it('accepts b23.tv short links', async () => {
    const { desktop } = await mount({ videoUrl: 'https://b23.tv/example' })
    await waitFor(() => desktop.media.length === 1)
    expect(desktop.media[0]?.url).toBe('https://b23.tv/example')
  })
})

describe('native media reconciliation', () => {
  it('contains a non-Error failure and retries after activity changes', async () => {
    const { ctx, desktop } = await mount()
    await waitFor(() => desktop.media.length === 1)
    const warn = vi.spyOn(ctx.logger, 'warn')
    desktop.failureOnce = 'native unavailable'
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => warn.mock.calls.length === 1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('native unavailable'))

    agentEvents(ctx, agent).emit('agent/status', { status: 'idle' })
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    await waitFor(() => desktop.media.at(-1)?.active === true && desktop.media.length >= 3)
  })

  it('reconciles a newer state after an older request fails', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeDesktopNative)
    const desktop = ctx.desktopNative as FakeDesktopNative
    const deferred = desktop.deferNext()
    await ctx.plugin(bilibiliCompanion, {})
    await waitFor(() => desktop.media.length === 1)
    const agent = fakeAgent()
    agentEvents(ctx, agent).emit('agent/status', { status: 'running' })
    deferred.reject(new Error('old state failed'))
    await waitFor(() => desktop.media.some(request => request.active))
  })

  it('bounds an unresponsive native request', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(FakeDesktopNative)
    const desktop = ctx.desktopNative as FakeDesktopNative
    desktop.deferNext()
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin(bilibiliCompanion, { nativeTimeoutMs: 10 })
    await waitFor(() => warn.mock.calls.length === 1)
    expect(warn.mock.calls[0]?.[0]).toContain('timeout')
  })
})

describe('plugin initialization state', () => {
  it('starts active when mounted after an already-running agent', async () => {
    const existing = { status: 'running' } as Agent
    class ExistingAgentRegistry extends Service {
      constructor(ctx: Context) { super(ctx, 'agents') }
      list(): Agent[] { return [existing] }
    }
    const ctx = new Context()
    context = ctx
    await ctx.plugin(ExistingAgentRegistry)
    await ctx.plugin(FakeDesktopNative)
    await ctx.plugin(bilibiliCompanion, {})
    const desktop = ctx.desktopNative as FakeDesktopNative
    await waitFor(() => desktop.media.length === 1)
    expect(desktop.media[0]?.active).toBe(true)
  })
})
