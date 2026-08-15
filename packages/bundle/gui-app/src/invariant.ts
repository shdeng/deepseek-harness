/** Package-owned invariant companion for `@deepseek-ai/dsh-gui-app`. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-gui-app'
/** Cordis companion plugin name. */
export const name = 'gui-app-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']
const install: InvariantInstaller = () => {}
/** Register the package's static-carrier invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
