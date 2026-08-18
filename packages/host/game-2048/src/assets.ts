import { mount2048 } from './game.ts'

/** Trusted self-contained document served only in the isolated game WebView. */
export const GAME_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>2048 · DeepSeek Harness</title>
  <link rel="stylesheet" href="./game.css">
  <script src="./game.js" defer></script>
</head>
<body>
  <main class="game-shell">
    <header class="game-header">
      <div><p class="eyebrow">GAME COMPANION</p><h1>2048</h1></div>
      <div class="scores" aria-label="分数">
        <div><span>分数</span><strong data-score>0</strong></div>
        <div><span>最佳</span><strong data-best>0</strong></div>
      </div>
    </header>
    <div class="toolbar">
      <p data-status role="status" aria-live="polite">等待 AI 开始工作</p>
      <button type="button" data-new-game>新游戏</button>
    </div>
    <section class="board" data-board role="grid" aria-label="2048 游戏棋盘"></section>
    <p class="instructions">使用方向键或 W A S D 移动方块。相同数字相撞时会合并。</p>
  </main>
  <div class="overlay" data-overlay role="dialog" aria-modal="true" aria-labelledby="attention-title" hidden>
    <div class="attention-card">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 9.01 9.01 0 0 0-9-9Zm1 13h-2v-2h2Zm0-4h-2V7h2Z"/></svg>
      <h2 id="attention-title" data-overlay-title>AI 已完成工作</h2>
      <p data-overlay-body>2048 已暂停。</p>
      <button type="button" data-return>返回 DeepSeek Harness</button>
    </div>
  </div>
</body>
</html>`

/** Dark, low-distraction game styling with visible focus and reduced-motion support. */
export const GAME_CSS = `:root {
  color-scheme: dark;
  --color-background: #0f172a;
  --color-surface: #172033;
  --color-surface-raised: #202b3f;
  --color-primary: #22c55e;
  --color-accent: #f59e0b;
  --color-text: #f8fafc;
  --color-muted: #cbd5e1;
  --color-border: rgba(255,255,255,.13);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 360px; min-height: 100vh; background: radial-gradient(circle at top, #1e293b 0, var(--color-background) 55%); color: var(--color-text); }
button { min-height: 44px; border: 1px solid var(--color-border); border-radius: 12px; padding: 0 18px; background: var(--color-surface-raised); color: var(--color-text); font: inherit; font-weight: 700; cursor: pointer; transition: background-color 180ms ease, border-color 180ms ease; }
button:hover { border-color: var(--color-primary); background: #26344b; }
button:focus-visible { outline: 3px solid var(--color-primary); outline-offset: 3px; }
.game-shell { width: min(100% - 32px, 560px); margin: 0 auto; padding: 28px 0 32px; }
.game-header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
.eyebrow { margin: 0 0 4px; color: var(--color-primary); font-size: 12px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 0; font-size: clamp(44px, 10vw, 72px); line-height: .9; letter-spacing: -.06em; }
.scores { display: flex; gap: 8px; }
.scores div { min-width: 78px; padding: 9px 12px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface); text-align: center; }
.scores span { display: block; color: var(--color-muted); font-size: 12px; }
.scores strong { display: block; margin-top: 2px; font-size: 22px; font-variant-numeric: tabular-nums; }
.toolbar { min-height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.toolbar p { margin: 0; color: var(--color-muted); line-height: 1.5; }
.board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; aspect-ratio: 1; padding: 12px; border: 1px solid var(--color-border); border-radius: 20px; background: #111827; box-shadow: 0 24px 60px rgba(0,0,0,.28); }
.tile { display: grid; place-items: center; min-width: 0; border-radius: 13px; background: #273449; color: var(--color-text); font-size: clamp(22px, 7vw, 42px); font-weight: 850; font-variant-numeric: tabular-nums; }
.tile[data-value="2"] { background: #334155; }
.tile[data-value="4"] { background: #3f4f67; }
.tile[data-value="8"] { background: #9a5b12; }
.tile[data-value="16"] { background: #a74616; }
.tile[data-value="32"], .tile[data-value="64"] { background: #b52f28; }
.tile[data-value="128"], .tile[data-value="256"], .tile[data-value="512"] { background: #8b6b13; font-size: clamp(18px, 5vw, 34px); }
.tile[data-value="1024"], .tile[data-value="2048"] { background: #15803d; font-size: clamp(16px, 4vw, 28px); }
.instructions { margin: 18px auto 0; max-width: 46ch; color: var(--color-muted); text-align: center; line-height: 1.6; }
.overlay { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; padding: 24px; background: rgba(2,6,23,.72); backdrop-filter: blur(8px); }
.overlay[hidden] { display: none; }
.attention-card { width: min(100%, 420px); padding: 32px; border: 1px solid var(--color-border); border-radius: 20px; background: var(--color-surface); box-shadow: 0 24px 80px rgba(0,0,0,.5); text-align: center; }
.attention-card svg { width: 48px; height: 48px; fill: var(--color-accent); }
.attention-card h2 { margin: 14px 0 8px; font-size: 28px; }
.attention-card p { margin: 0 0 22px; color: var(--color-muted); line-height: 1.6; }
.attention-card button { width: 100%; background: var(--color-primary); border-color: var(--color-primary); color: #052e16; }
@media (max-width: 480px) { .game-header { align-items: start; flex-direction: column; } .scores { width: 100%; } .scores div { flex: 1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
`

/** Browser logic generated from the typed self-contained entry function. */
export const GAME_SCRIPT = `(${mount2048.toString()})();\n`
