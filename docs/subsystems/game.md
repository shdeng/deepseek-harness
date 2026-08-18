# Companion Games

English | [中文](game.zh.md)

[`@deepseek-ai/dsh-game`](../../packages/host/game) defines `ctx.games`, the Host registry for human-played Desktop companion games. Providers register bounded self-contained text assets under a stable id; Consumers resolve content-addressed entry URLs without learning provider filesystem paths.

Registration and removal are synchronous effects. Each revision digest includes the game id, sorted asset paths, media types, and complete bodies. The private Desktop sidecar reads a current digest and normalized path, while the capability-free game WebView receives only the resulting response.

Design record: [Desktop game companion Agent Note](../../.agents/notes/implemented/feature/2026-08-17-desktop-game-companion-and-local-providers.md).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxgames--gameregistry"></a>

### `ctx.games` — `GameRegistry`

Dynamic registry of local companion-game Providers and their immutable assets.

```ts cordis-catalog
/**
 * Register one borrowed game contribution for the calling plugin fiber.
 * Duplicate ids throw before mutation. Disposal removes the exact entry and
 * makes its content digest unreadable to new Desktop protocol requests.
 * @param game - validated metadata and complete text assets.
 * @returns disposer for the exact registration.
 */
register(game: GameRegistration): () => void

/**
 * List every currently registered game in stable id order.
 * @returns sorted game metadata.
 */
list(): GameDescriptor[]

/**
 * Resolve one current game by its stable id.
 * @param id - validated stable game selector.
 * @returns current descriptor, or undefined without a matching Provider.
 */
get(id: GameId): GameDescriptor | undefined

/**
 * Read one asset after the private wire parser validates its digest and path.
 * @param assetId - content digest minted by this registry.
 * @param path - normalized relative asset path.
 * @returns asset bytes and media type, or undefined after disposal or for an unknown path.
 */
readAsset(assetId: GameAssetId, path: string): GameAsset | undefined
```

Source: [`packages/host/game/src/index.ts:146`](../../packages/host/game/src/index.ts)

<a id="games-events"></a>

### `games/*` events

<a id="gameschange--emit"></a>

#### `games/change` — emit

A game Provider registration changed after the registry commit point.

```ts cordis-catalog
/**
 * A game Provider registration changed after the registry commit point.
 * @mode emit
 * @param change - exact game and committed mutation.
 */
'games/change'(change: GameRegistryChange): void
```

Source: [`packages/host/game/src/index.ts:99`](../../packages/host/game/src/index.ts)
<!-- END GENERATED cordis-surface -->
