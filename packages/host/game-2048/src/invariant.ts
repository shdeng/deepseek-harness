/** Package-owned invariant companion for `@deepseek-ai/dsh-game-2048`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-game-2048'

/** Cordis companion plugin name. */
export const name = 'game-2048-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the game registry owns contribution and asset consistency. */
const install: InvariantInstaller = () => {}

/** Register the package's empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
