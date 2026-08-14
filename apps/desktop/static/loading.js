const status = document.getElementById('status')
const picker = document.getElementById('pick-directory')

window.__DSH_DESKTOP_SET_STATUS__ = (message) => {
  status.textContent = message
}

picker.addEventListener('click', async () => {
  const invoke = window.__TAURI__?.core?.invoke
  if (invoke === undefined) {
    status.textContent = 'Tauri IPC is unavailable on this page.'
    return
  }
  picker.disabled = true
  try {
    const path = await invoke('desktop_pick_directory')
    status.textContent = path === null ? 'Directory selection cancelled.' : `Selected: ${path}`
  } catch (error) {
    status.textContent = `Directory picker failed: ${String(error)}`
  } finally {
    picker.disabled = false
  }
})
