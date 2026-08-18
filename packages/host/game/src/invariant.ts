/** Package-owned invariant companion for `@deepseek-ai/dsh-game`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-game'

/** Cordis companion plugin name. */
export const name = 'game-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

const install: InvariantInstaller = (ctx, fail) => {
  const verify = (): void => {
    const games = ctx.get('games')
    if (games === undefined) return
    for (const descriptor of games.list()) {
      /* v8 ignore next -- this is the invariant failure; registry tests cover the authoritative identity relationship. */
      if (games.get(descriptor.id) !== descriptor) {
        /* v8 ignore next -- reached only after the invariant above is violated. */
        fail(`list/get identity diverged for game ${JSON.stringify(descriptor.id)}`)
      }
    }
  }
  ctx.on('games/change', verify)
  verify()
}

/** Register the package's game-registry invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
