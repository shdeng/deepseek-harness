/**
 * Registry for human-played desktop companion games. Providers register
 * bounded self-contained web assets; Desktop consumers resolve immutable,
 * content-addressed entry URLs without receiving filesystem paths.
 * @module @deepseek-ai/dsh-game
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ASSET_PATH = /^[a-z0-9][a-z0-9._/-]*$/
const ASSET_DIGEST = /^[a-f0-9]{64}$/
const MAX_ASSET_BYTES = 512 * 1024
const MAX_GAME_BYTES = 2 * 1024 * 1024
const ENTRY_PATH = 'index.html'
const MEDIA_TYPES = new Set([
  'text/css; charset=utf-8',
  'text/html; charset=utf-8',
  'text/javascript; charset=utf-8',
])

/** Stable kebab-case identifier for one game registration. */
export type GameId = Branded<'GameId'>

/**
 * Brand a validated game identifier.
 * @param value - kebab-case game id already validated at its input boundary.
 * @returns opaque game id.
 */
export function GameId(value: string): GameId {
  return value as GameId
}

/** Content digest used as the opaque authority for one game revision. */
export type GameAssetId = Branded<'GameAssetId'>

/**
 * Brand a validated game asset digest.
 * @param value - SHA-256 digest already validated at its input boundary.
 * @returns opaque game asset id.
 */
export function GameAssetId(value: string): GameAssetId {
  return value as GameAssetId
}

/** One UTF-8 asset contributed by a game Provider. */
export interface GameAssetRegistration {
  /** Relative lowercase path inside the game's isolated origin. */
  readonly path: string
  /** Closed text media type returned by the Desktop custom protocol. */
  readonly contentType: 'text/css; charset=utf-8' | 'text/html; charset=utf-8' | 'text/javascript; charset=utf-8'
  /** Complete UTF-8 response body. */
  readonly body: string
}

/** Complete game contribution registered synchronously during plugin apply. */
export interface GameRegistration {
  /** Stable game selector. */
  readonly id: GameId
  /** Bounded operator-visible title. */
  readonly title: string
  /** Self-contained HTML, CSS, and JavaScript assets including `index.html`. */
  readonly assets: readonly GameAssetRegistration[]
}

/** Human-facing game metadata plus its immutable Desktop entry URL. */
export interface GameDescriptor {
  readonly id: GameId
  readonly title: string
  readonly assetId: GameAssetId
  readonly url: string
}

/** Asset response borrowed by the private Desktop sidecar. */
export interface GameAsset {
  readonly contentType: GameAssetRegistration['contentType']
  readonly body: string
}

/** Registry mutation observed by presentation Consumers. */
export interface GameRegistryChange {
  readonly id: GameId
  readonly kind: 'registered' | 'removed'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    games: GameRegistry
  }

  interface Events {
    /**
     * A game Provider registration changed after the registry commit point.
     * @mode emit
     * @param change - exact game and committed mutation.
     */
    'games/change'(change: GameRegistryChange): void
  }
}

interface StoredGame {
  descriptor: GameDescriptor
  assets: ReadonlyMap<string, GameAsset>
}

function validateRegistration(game: GameRegistration): void {
  if (!GAME_ID.test(game.id)) {
    throw new TypeError(`games: id must be lowercase kebab-case, got ${JSON.stringify(game.id)}`)
  }
  if (game.title.length === 0 || game.title.length > 80 || game.title.trim() !== game.title) {
    throw new TypeError('games: title must contain 1-80 characters without surrounding whitespace')
  }
  if (game.assets.length === 0) throw new TypeError('games: assets must not be empty')
  const paths = new Set<string>()
  let total = 0
  for (const asset of game.assets) {
    if (!ASSET_PATH.test(asset.path) || asset.path.includes('..') || asset.path.includes('//')) {
      throw new TypeError(`games: asset path is not a normalized relative path: ${JSON.stringify(asset.path)}`)
    }
    if (paths.has(asset.path)) throw new TypeError(`games: duplicate asset path ${JSON.stringify(asset.path)}`)
    paths.add(asset.path)
    if (!MEDIA_TYPES.has(asset.contentType)) {
      throw new TypeError(`games: unsupported asset media type ${JSON.stringify(asset.contentType)}`)
    }
    const size = Buffer.byteLength(asset.body)
    if (size > MAX_ASSET_BYTES) {
      throw new TypeError(`games: asset ${JSON.stringify(asset.path)} exceeds ${String(MAX_ASSET_BYTES)} bytes`)
    }
    total += size
  }
  if (!paths.has(ENTRY_PATH)) throw new TypeError(`games: assets must include ${JSON.stringify(ENTRY_PATH)}`)
  if (total > MAX_GAME_BYTES) throw new TypeError(`games: complete asset set exceeds ${String(MAX_GAME_BYTES)} bytes`)
}

function digestOf(game: GameRegistration): GameAssetId {
  const hash = createHash('sha256').update(game.id).update('\0')
  for (const asset of [...game.assets].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(asset.path).update('\0').update(asset.contentType).update('\0').update(asset.body).update('\0')
  }
  return GameAssetId(hash.digest('hex'))
}

/** Dynamic registry of local companion-game Providers and their immutable assets. */
export class GameRegistry extends Service {
  private readonly entries = new Map<GameId, StoredGame>()
  private readonly byAsset = new Map<GameAssetId, StoredGame>()

  constructor(ctx: Context) {
    super(ctx, 'games')
  }

  /**
   * Register one borrowed game contribution for the calling plugin fiber.
   * Duplicate ids throw before mutation. Disposal removes the exact entry and
   * makes its content digest unreadable to new Desktop protocol requests.
   * @param game - validated metadata and complete text assets.
   * @returns disposer for the exact registration.
   */
  register(game: GameRegistration): () => void {
    validateRegistration(game)
    if (this.entries.has(game.id)) throw new Error(`games: id ${JSON.stringify(game.id)} is already registered`)
    const assetId = digestOf(game)
    const stored: StoredGame = {
      descriptor: {
        id: game.id,
        title: game.title,
        assetId,
        url: `dsh-game://localhost/${assetId}/${ENTRY_PATH}`,
      },
      assets: new Map(game.assets.map(asset => [asset.path, { contentType: asset.contentType, body: asset.body }])),
    }
    const dispose = this.ctx.effect(() => {
      this.entries.set(game.id, stored)
      this.byAsset.set(assetId, stored)
      this.ctx.emit('games/change', { id: game.id, kind: 'registered' })
      return () => {
        /* v8 ignore next -- the Cordis effect disposer is single-shot and only this exact registration can replace its entry. */
        if (this.entries.get(game.id) !== stored) return
        this.entries.delete(game.id)
        this.byAsset.delete(assetId)
        this.ctx.emit('games/change', { id: game.id, kind: 'removed' })
      }
    }, `games.register(${JSON.stringify(game.id)})`)
    return () => { void dispose() }
  }

  /**
   * List every currently registered game in stable id order.
   * @returns sorted game metadata.
   */
  list(): GameDescriptor[] {
    return [...this.entries.values()].map(entry => entry.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Resolve one current game by its stable id.
   * @param id - validated stable game selector.
   * @returns current descriptor, or undefined without a matching Provider.
   */
  get(id: GameId): GameDescriptor | undefined {
    return this.entries.get(id)?.descriptor
  }

  /**
   * Read one asset after the private wire parser validates its digest and path.
   * @param assetId - content digest minted by this registry.
   * @param path - normalized relative asset path.
   * @returns asset bytes and media type, or undefined after disposal or for an unknown path.
   */
  readAsset(assetId: GameAssetId, path: string): GameAsset | undefined {
    return this.byAsset.get(assetId)?.assets.get(path)
  }

  /**
   * Validate an untrusted digest before branding it at the Desktop wire boundary.
   * @param value - untrusted wire string.
   * @returns validated opaque game asset id.
   */
  static parseAssetId(value: string): GameAssetId {
    if (!ASSET_DIGEST.test(value)) throw new TypeError('game asset id must be a 64-character lowercase hex digest')
    return GameAssetId(value)
  }
}

export default GameRegistry
