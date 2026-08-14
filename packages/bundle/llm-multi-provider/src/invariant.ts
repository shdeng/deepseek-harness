/** Package-owned invariant companion for the optional multi-provider bundle. @module @deepseek-ai/dsh-llm-multi-provider/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-multi-provider'

/** Cordis companion plugin name. */
export const name = 'llm-multi-provider-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: the package is a static patch-list carrier and owns
// no mutable runtime relation; the inserted adapter owns its own invariants.
const install: InvariantInstaller = () => {}

/**
 * Register this package's empty invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
