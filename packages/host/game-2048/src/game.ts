/** Browser entry serialized into the isolated 2048 game asset. */
export function mount2048(): void {
  type Mode = 'hidden' | 'playable' | 'attention'
  interface HostState { mode: Mode; activeAgentCount: number; reason?: 'work-complete' | 'approval' }
  interface SavedState { board: number[]; score: number; best: number }
  interface GameWindow extends Window {
    __DSH_GAME_STATE__?: HostState
  }

  const SIZE = 4
  const STORAGE_KEY = 'deepseek-harness:game-2048:v1'
  const boardElement = document.querySelector<HTMLElement>('[data-board]')
  const scoreElement = document.querySelector<HTMLElement>('[data-score]')
  const bestElement = document.querySelector<HTMLElement>('[data-best]')
  const statusElement = document.querySelector<HTMLElement>('[data-status]')
  const overlayElement = document.querySelector<HTMLElement>('[data-overlay]')
  const overlayTitle = document.querySelector<HTMLElement>('[data-overlay-title]')
  const overlayBody = document.querySelector<HTMLElement>('[data-overlay-body]')
  const newGameButton = document.querySelector<HTMLButtonElement>('[data-new-game]')
  const returnButton = document.querySelector<HTMLButtonElement>('[data-return]')
  /* v8 ignore start -- the paired static Provider document owns these exact elements; this guard diagnoses asset-version mismatch. */
  if (boardElement === null || scoreElement === null || bestElement === null || statusElement === null
    || overlayElement === null || overlayTitle === null || overlayBody === null
    || newGameButton === null || returnButton === null) {
    throw new Error('2048 game document is missing required elements')
  }
  /* v8 ignore stop */

  let board = Array<number>(SIZE * SIZE).fill(0)
  let score = 0
  let best = 0
  let mode: Mode = 'hidden'

  const validSavedState = (value: unknown): value is SavedState => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const candidate = value as Partial<SavedState>
    return Array.isArray(candidate.board) && candidate.board.length === SIZE * SIZE
      && candidate.board.every(tile => Number.isSafeInteger(tile) && tile >= 0)
      && Number.isSafeInteger(candidate.score) && (candidate.score as number) >= 0
      && Number.isSafeInteger(candidate.best) && (candidate.best as number) >= 0
  }

  const load = (): boolean => {
    try {
      const encoded = localStorage.getItem(STORAGE_KEY)
      if (encoded === null) return false
      const value: unknown = JSON.parse(encoded)
      if (!validSavedState(value)) return false
      board = [...value.board]
      score = value.score
      best = value.best
      return true
    } catch {
      // Corrupt or unavailable local storage starts a fresh local game.
      return false
    }
  }

  const save = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ board, score, best }))
    } catch {
      // Storage denial does not make the in-memory game unplayable.
    }
  }

  const addTile = (): void => {
    const empty = board.flatMap((tile, index) => tile === 0 ? [index] : [])
    /* v8 ignore next -- fresh games and changed moves always have an empty position before tile insertion. */
    if (empty.length === 0) return
    const slot = empty[Math.floor(Math.random() * empty.length)]
    /* v8 ignore next -- Math.random() is in [0, 1), so a non-empty array always yields a slot. */
    if (slot === undefined) return
    board[slot] = Math.random() < 0.9 ? 2 : 4
  }

  const render = (): void => {
    boardElement.replaceChildren(...board.map((tile) => {
      const cell = document.createElement('div')
      cell.className = 'tile'
      cell.dataset.value = String(tile)
      cell.setAttribute('role', 'gridcell')
      cell.setAttribute('aria-label', tile === 0 ? '空格' : String(tile))
      cell.textContent = tile === 0 ? '' : String(tile)
      return cell
    }))
    scoreElement.textContent = String(score)
    bestElement.textContent = String(best)
  }

  const fresh = (): void => {
    board = Array<number>(SIZE * SIZE).fill(0)
    score = 0
    addTile()
    addTile()
    render()
    save()
    statusElement.textContent = '新游戏已开始'
  }

  const collapse = (line: readonly number[]): { line: number[]; gained: number } => {
    const compact = line.filter(value => value !== 0)
    const merged: number[] = []
    let gained = 0
    for (let index = 0; index < compact.length; index += 1) {
      const current = compact[index] as number
      const next = compact[index + 1]
      if (current === next) {
        const value = current * 2
        merged.push(value)
        gained += value
        index += 1
      } else {
        merged.push(current)
      }
    }
    return { line: [...merged, ...Array<number>(SIZE - merged.length).fill(0)], gained }
  }

  const indices = (direction: 'left' | 'right' | 'up' | 'down', line: number): number[] => {
    const values = Array.from({ length: SIZE }, (_, offset) => direction === 'left' || direction === 'right'
      ? line * SIZE + offset
      : offset * SIZE + line)
    return direction === 'right' || direction === 'down' ? values.reverse() : values
  }

  const canMove = (): boolean => {
    if (board.includes(0)) return true
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        const value = board[row * SIZE + column]
        if (column + 1 < SIZE && value === board[row * SIZE + column + 1]) return true
        if (row + 1 < SIZE && value === board[(row + 1) * SIZE + column]) return true
      }
    }
    return false
  }

  const move = (direction: 'left' | 'right' | 'up' | 'down'): void => {
    if (mode !== 'playable') return
    const before = board.join(',')
    let gained = 0
    for (let line = 0; line < SIZE; line += 1) {
      const positions = indices(direction, line)
      const collapsed = collapse(positions.map(position => board[position] as number))
      gained += collapsed.gained
      positions.forEach((position, offset) => { board[position] = collapsed.line[offset] as number })
    }
    if (board.join(',') === before) return
    score += gained
    best = Math.max(best, score)
    addTile()
    render()
    save()
    if (board.includes(2048)) statusElement.textContent = '已合成 2048，可以继续挑战更高分'
    else if (!canMove()) statusElement.textContent = '没有可移动的方块，请开始新游戏'
    else statusElement.textContent = gained === 0 ? '已移动' : `合并得分 ${String(gained)}`
  }

  const applyHostState = (state: HostState): void => {
    mode = state.mode
    document.documentElement.dataset.gameMode = state.mode
    statusElement.textContent = state.mode === 'playable'
      ? `AI 正在工作 · ${String(state.activeAgentCount)} 个活动任务`
      : '游戏已暂停'
    const attention = state.mode === 'attention'
    overlayElement.hidden = !attention
    overlayElement.setAttribute('aria-hidden', attention ? 'false' : 'true')
    if (attention) {
      overlayTitle.textContent = state.reason === 'approval' ? 'AI 需要你的确认' : 'AI 已完成工作'
      overlayBody.textContent = '2048 已暂停。返回 DeepSeek Harness 查看任务。'
      returnButton.focus()
    }
  }

  const keyDirections: Readonly<Record<string, 'left' | 'right' | 'up' | 'down'>> = {
    ArrowLeft: 'left', a: 'left', A: 'left',
    ArrowRight: 'right', d: 'right', D: 'right',
    ArrowUp: 'up', w: 'up', W: 'up',
    ArrowDown: 'down', s: 'down', S: 'down',
  }
  document.addEventListener('keydown', (event) => {
    const direction = keyDirections[event.key]
    if (direction === undefined) return
    event.preventDefault()
    move(direction)
  })
  document.addEventListener('dsh-game-state', (event) => {
    const state = (event as CustomEvent<HostState>).detail
    applyHostState(state)
  })
  newGameButton.addEventListener('click', fresh)
  /* v8 ignore next -- the Rust navigation fence owns and tests this return-to-main action. */
  returnButton.addEventListener('click', () => { window.location.assign('./return-to-harness') })

  if (!load()) fresh()
  else render()
  applyHostState((window as GameWindow).__DSH_GAME_STATE__ ?? { mode: 'hidden', activeAgentCount: 0 })
}
