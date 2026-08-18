// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GameRegistry, { GameId } from '@deepseek-ai/dsh-game'
import { GAME_HTML, GAME_SCRIPT } from '../src/assets.ts'
import { mount2048 } from '../src/game.ts'
import * as provider from '../src/index.ts'

function installDocument(): void {
  const parsed = new DOMParser().parseFromString(GAME_HTML, 'text/html')
  document.head.replaceChildren(...parsed.head.childNodes)
  document.body.replaceChildren(...parsed.body.childNodes)
}

const STORAGE_KEY = 'deepseek-harness:game-2048:v1'

function seed(board: number[], score = 0, best = 0): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ board, score, best }))
}

function setPlayable(): void {
  document.dispatchEvent(new CustomEvent('dsh-game-state', {
    detail: { mode: 'playable', activeAgentCount: 1 },
  }))
}

const invalidSavedStates: unknown[] = [
  null,
  [],
  {},
  { board: Array<number>(15).fill(0), score: 0, best: 0 },
  { board: [-1, ...Array<number>(15).fill(0)], score: 0, best: 0 },
  { board: [1.5, ...Array<number>(15).fill(0)], score: 0, best: 0 },
  { board: Array<number>(16).fill(0), score: -1, best: 0 },
  { board: Array<number>(16).fill(0), score: 1.5, best: 0 },
  { board: Array<number>(16).fill(0), score: 0, best: -1 },
  { board: Array<number>(16).fill(0), score: 0, best: 1.5 },
]

const directionalMoves: readonly [string, number[]][] = [
  ['ArrowRight', [2, 0, 0, 0, ...Array<number>(12).fill(0)]],
  ['ArrowUp', [0, 0, 0, 0, 2, 0, 0, 0, ...Array<number>(8).fill(0)]],
  ['ArrowDown', [2, 0, 0, 0, ...Array<number>(12).fill(0)]],
]

beforeEach(() => {
  localStorage.clear()
  installDocument()
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('2048 browser game', () => {
  it('mounts accessibly, enables input only while playable, and persists score', () => {
    mount2048()
    const board = document.querySelector('[data-board]')
    expect(board?.children).toHaveLength(16)
    expect(document.querySelector('[data-overlay]')?.hasAttribute('hidden')).toBe(true)

    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }))
    expect(document.querySelector('[data-score]')?.textContent).toBe('4')
    expect(localStorage.getItem(STORAGE_KEY)).toContain('"score":4')

    document.dispatchEvent(new CustomEvent('dsh-game-state', {
      detail: { mode: 'attention', activeAgentCount: 0, reason: 'work-complete' },
    }))
    const score = document.querySelector('[data-score]')?.textContent
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }))
    expect(document.querySelector('[data-score]')?.textContent).toBe(score)
    expect(document.querySelector('[data-overlay]')?.hasAttribute('hidden')).toBe(false)
    expect(document.activeElement).toBe(document.querySelector('[data-return]'))
  })

  it('recovers from corrupt persisted data and exposes a standalone generated script', () => {
    localStorage.setItem(STORAGE_KEY, '{bad json')
    mount2048()
    expect([...document.querySelectorAll('[data-value="2"]')]).toHaveLength(2)
    expect(GAME_SCRIPT).toContain('mount2048')
  })

  it.each(invalidSavedStates)('rejects invalid saved state %#', (value) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    mount2048()
    expect(document.querySelectorAll('[data-value="2"]')).toHaveLength(2)
  })

  it('continues when browser storage reads or writes fail', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => { mount2048() }).not.toThrow()
    read.mockRestore()
    write.mockRestore()
  })

  it('restores a valid save and initial Host state, then supports reset and approval attention', () => {
    seed([2, ...Array<number>(15).fill(0)], 8, 16)
    ;(window as Window & { __DSH_GAME_STATE__?: unknown }).__DSH_GAME_STATE__ = {
      mode: 'playable', activeAgentCount: 2,
    }
    mount2048()
    expect(document.querySelector('[data-score]')?.textContent).toBe('8')
    expect(document.querySelector('[data-best]')?.textContent).toBe('16')
    document.querySelector<HTMLButtonElement>('[data-new-game]')?.click()
    expect(document.querySelector('[data-score]')?.textContent).toBe('0')
    document.dispatchEvent(new CustomEvent('dsh-game-state', {
      detail: { mode: 'attention', activeAgentCount: 1, reason: 'approval' },
    }))
    expect(document.querySelector('[data-overlay-title]')?.textContent).toContain('确认')
  })

  it('can spawn four-valued tiles', () => {
    vi.mocked(Math.random).mockReturnValue(0.95)
    mount2048()
    expect(document.querySelectorAll('[data-value="4"]')).toHaveLength(2)
  })

  it.each(directionalMoves)('moves with %s', (key, board) => {
    seed([...board])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }))
    expect(document.querySelector('[data-status]')?.textContent).toBe('已移动')
  })

  it('ignores unrelated and unchanged moves', () => {
    seed([2, ...Array<number>(15).fill(0)])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', cancelable: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }))
    expect(document.querySelector('[data-score]')?.textContent).toBe('0')
  })

  it('announces 2048 and a board with no remaining move', () => {
    seed([1024, 1024, ...Array<number>(14).fill(0)])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }))
    expect(document.querySelector('[data-status]')?.textContent).toContain('已合成 2048')
  })

  it('detects a full board with no adjacent match after insertion', () => {
    seed([
      0, 2, 4, 8,
      4, 8, 16, 4,
      8, 16, 4, 8,
      16, 4, 8, 16,
    ])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }))
    expect(document.querySelector('[data-status]')?.textContent).toContain('没有可移动')
  })

  it('detects remaining horizontal and vertical matches on a full board', () => {
    seed([
      0, 2, 4, 8,
      4, 16, 16, 4,
      8, 4, 8, 16,
      16, 8, 4, 2,
    ])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true }))
    expect(document.querySelector('[data-status]')?.textContent).not.toContain('没有可移动')
  })

  it('detects a remaining vertical match after filling the board', () => {
    seed([
      0, 2, 4, 8,
      4, 8, 16, 4,
      16, 8, 4, 16,
      8, 16, 2, 8,
    ])
    mount2048()
    setPlayable()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true }))
    expect(document.querySelector('[data-status]')?.textContent).not.toContain('没有可移动')
  })
})

describe('2048 Provider', () => {
  it('registers its complete asset set for the plugin lifetime', async () => {
    const ctx = new Context()
    await ctx.plugin(GameRegistry)
    const fiber = ctx.plugin(provider)
    await fiber
    const descriptor = ctx.games.get(GameId('2048'))
    expect(descriptor).toBeDefined()
    expect(ctx.games.readAsset(descriptor!.assetId, 'index.html')?.body).toContain('data-board')
    await fiber.dispose()
    expect(ctx.games.get(GameId('2048'))).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
