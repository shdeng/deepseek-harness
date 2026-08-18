/** Package-owned invariant companion for `@deepseek-ai/dsh-game-companion`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-game-companion'

/** Cordis companion plugin name. */
export const name = 'game-companion-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Rust owns window visibility and game input state, so
 * the Host has no independent authoritative state to compare with its intent.
 */
const install: InvariantInstaller = () => {}

/** Register the package's empty invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
