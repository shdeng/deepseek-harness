const status = document.getElementById('status')

window.__DSH_DESKTOP_SET_STATUS__ = (message) => {
  status.textContent = message
}
