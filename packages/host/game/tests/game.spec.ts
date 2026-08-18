import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GameRegistry, { GameId } from '../src/index.ts'

let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
})

async function mounted(): Promise<Context> {
  context = new Context()
  await context.plugin(GameRegistry)
  return context
}

const sample = (id = 'sample') => ({
  id: GameId(id),
  title: 'Sample Game',
  assets: [
    { path: 'index.html', contentType: 'text/html; charset=utf-8' as const, body: '<script src="./game.js"></script>' },
    { path: 'game.js', contentType: 'text/javascript; charset=utf-8' as const, body: 'document.title = "Sample"' },
  ],
})

describe('game registry', () => {
  it('publishes content-addressed assets and removes the exact registration on disposal', async () => {
    const ctx = await mounted()
    const changes: string[] = []
    ctx.on('games/change', (change) => { changes.push(`${change.kind}:${change.id}`) })
    const dispose = ctx.games.register(sample())
    const descriptor = ctx.games.get(GameId('sample'))
    expect(descriptor).toBeDefined()
    expect(ctx.games.list()).toEqual([descriptor])
    expect(descriptor?.url).toMatch(/^dsh-game:\/\/localhost\/[a-f0-9]{64}\/index\.html$/)
    expect(ctx.games.readAsset(descriptor!.assetId, 'game.js')).toEqual({
      contentType: 'text/javascript; charset=utf-8',
      body: 'document.title = "Sample"',
    })

    dispose()
    expect(ctx.games.get(GameId('sample'))).toBeUndefined()
    expect(ctx.games.readAsset(descriptor!.assetId, 'index.html')).toBeUndefined()
    expect(changes).toEqual(['registered:sample', 'removed:sample'])
  })

  it('rejects duplicates and unsafe or incomplete asset sets before mutation', async () => {
    const ctx = await mounted()
    ctx.games.register(sample())
    expect(() => ctx.games.register(sample())).toThrow(/already registered/)
    expect(() => ctx.games.register(sample('Bad Id'))).toThrow(/lowercase kebab-case/)
    for (const title of ['', 'x'.repeat(81), ' padded ']) {
      expect(() => ctx.games.register({ ...sample(`title-${title.length}`), title })).toThrow(/title must contain/)
    }
    expect(() => ctx.games.register({ ...sample('empty'), assets: [] })).toThrow(/must not be empty/)
    expect(() => ctx.games.register({
      ...sample('escape'),
      assets: [{ path: '../index.html', contentType: 'text/html; charset=utf-8', body: '' }],
    })).toThrow(/normalized relative path/)
    expect(() => ctx.games.register({
      ...sample('double-slash'),
      assets: [{ path: 'nested//index.html', contentType: 'text/html; charset=utf-8', body: '' }],
    })).toThrow(/normalized relative path/)
    expect(() => ctx.games.register({
      ...sample('duplicate-path'),
      assets: [
        { path: 'index.html', contentType: 'text/html; charset=utf-8', body: '' },
        { path: 'index.html', contentType: 'text/html; charset=utf-8', body: '' },
      ],
    })).toThrow(/duplicate asset path/)
    expect(() => ctx.games.register({
      ...sample('media-type'),
      assets: [{ path: 'index.html', contentType: 'application/json' as never, body: '' }],
    })).toThrow(/unsupported asset media type/)
    expect(() => ctx.games.register({
      ...sample('large-asset'),
      assets: [{ path: 'index.html', contentType: 'text/html; charset=utf-8', body: 'x'.repeat(512 * 1024 + 1) }],
    })).toThrow(/asset .* exceeds/)
    expect(() => ctx.games.register({
      ...sample('missing'),
      assets: [{ path: 'game.js', contentType: 'text/javascript; charset=utf-8', body: '' }],
    })).toThrow(/must include/)
    expect(() => ctx.games.register({
      ...sample('large-game'),
      assets: Array.from({ length: 5 }, (_, index) => ({
        path: index === 0 ? 'index.html' : `asset-${String(index)}.js`,
        contentType: index === 0 ? 'text/html; charset=utf-8' as const : 'text/javascript; charset=utf-8' as const,
        body: 'x'.repeat(430 * 1024),
      })),
    })).toThrow(/complete asset set exceeds/)
  })

  it('sorts descriptors by id and makes asset revisions independent of input order', async () => {
    const ctx = await mounted()
    const reverse = sample('zeta')
    ctx.games.register({ ...reverse, assets: [...reverse.assets].reverse() })
    ctx.games.register(sample('alpha'))
    expect(ctx.games.list().map(game => game.id)).toEqual(['alpha', 'zeta'])
    const first = ctx.games.get(GameId('zeta'))
    const comparison = new Context()
    await comparison.plugin(GameRegistry)
    comparison.games.register(reverse)
    expect(comparison.games.get(GameId('zeta'))?.assetId).toBe(first?.assetId)
    await comparison.fiber.dispose()
  })

  it('brands only valid wire asset digests', () => {
    expect(GameRegistry.parseAssetId('a'.repeat(64))).toBe('a'.repeat(64))
    expect(() => GameRegistry.parseAssetId('A'.repeat(64))).toThrow(/lowercase hex digest/)
  })
})
