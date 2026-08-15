/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * loader holding, module-table seeding, AppRoot gate, plugin assembly — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
const root = el

interface DesktopWindow extends Window {
  __DSH_DESKTOP_IPC__?: boolean
  __DSH_DESKTOP_SET_STATUS__?: (message: string) => void
  __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } }
}

async function boot(): Promise<void> {
  const shell = window as DesktopWindow
  if (shell.__DSH_DESKTOP_IPC__ !== true) {
    await new AppWebEntry(root).run()
    return
  }
  shell.__DSH_DESKTOP_SET_STATUS__ = (message: string): void => {
    root.textContent = message
  }
  root.textContent = 'Starting DeepSeek Harness…'
  const invoke = shell.__TAURI__?.core?.invoke
  if (invoke === undefined) throw new Error('desktop app: Tauri invoke API is unavailable')
  const manifest = await invoke('desktop_boot_manifest')
  await new AppWebEntry(root, { manifest }).run()
}

void boot().catch((error: unknown) => {
  console.error(error)
  root.textContent = error instanceof Error ? error.message : String(error)
})
