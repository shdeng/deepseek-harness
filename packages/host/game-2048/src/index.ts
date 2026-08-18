/** 2048 Provider for the local Desktop companion-game registry. */

import type { Context } from '@deepseek-ai/cordis'
import { GameId } from '@deepseek-ai/dsh-game'
import { GAME_CSS, GAME_HTML, GAME_SCRIPT } from './assets.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'game-2048'
/** Registry required for the Provider contribution. */
export const inject = ['games']

/** Register the self-contained 2048 document for the calling plugin lifetime. */
export function apply(ctx: Context): void {
  ctx.games.register({
    id: GameId('2048'),
    title: '2048',
    assets: [
      { path: 'index.html', contentType: 'text/html; charset=utf-8', body: GAME_HTML },
      { path: 'game.css', contentType: 'text/css; charset=utf-8', body: GAME_CSS },
      { path: 'game.js', contentType: 'text/javascript; charset=utf-8', body: GAME_SCRIPT },
    ],
  })
}
