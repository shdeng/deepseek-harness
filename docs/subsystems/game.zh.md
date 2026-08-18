# 伴随游戏

[English](game.md) | 中文

[`@deepseek-ai/dsh-game`](../../packages/host/game) 定义了 `ctx.games`，即供人类游玩的 Desktop 伴随游戏 Host 注册表。Provider 以稳定 id 注册有界、自包含的文本资产；Consumer 解析内容摘要寻址入口 URL，但不会得知 Provider 文件系统路径。

注册与移除都是同步 effect。每个版本摘要包含游戏 id、排序后的资产路径、媒体类型和完整正文。私有 Desktop sidecar 读取当前摘要与规范化路径，而没有 capability 的游戏 WebView 只接收结果响应。

设计记录：[Desktop 游戏伴随窗口 Agent Note](../../.agents/notes/implemented/feature/2026-08-17-desktop-game-companion-and-local-providers.md)。

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
