import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createInterface } from 'node:readline'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourcesDir = path.join(appDir, 'src-tauri', 'release-resources')
const hostDir = path.join(resourcesDir, 'host')
const node = path.join(resourcesDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
const cli = path.join(hostDir, 'lib', 'bin.js')
const harnessHome = mkdtempSync(path.join(tmpdir(), 'dsh-desktop-release-smoke-'))
const timeoutMs = 30_000

const child = spawn(node, [
  '--expose-internals',
  cli,
  'web',
  '--host', '127.0.0.1',
  '--port', '0',
], {
  cwd: hostDir,
  env: {
    ...process.env,
    DSH_DESKTOP_SIDECAR: '1',
    DSH_DESKTOP_SUPERVISED_STDIN: '1',
    DSH_HOME: harnessHome,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let started = false
let shutdownComplete = false
let timedOut = false
let stderr = ''
const timeout = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
}, timeoutMs)

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  stderr += chunk
  process.stderr.write(chunk)
})

const output = createInterface({ input: child.stdout, crlfDelay: Infinity })
output.on('line', (line) => {
  process.stdout.write(`${line}\n`)
  if (!started && line.startsWith('dsh web: http://127.0.0.1:')) {
    started = true
    child.stdin.write('DSH-IPC/1 {"v":1,"kind":"shutdown","id":"release-smoke"}\n')
  }
  if (line.startsWith('DSH-IPC/1 ') && line.includes('"kind":"shutdown-complete"')) {
    shutdownComplete = true
  }
})

try {
  const [code] = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (...args) => resolve(args))
  })
  if (code !== 0 || !started || !shutdownComplete) {
    throw new Error(
      `packaged Host smoke failed: exit=${String(code)}, started=${String(started)}, `
      + `shutdownComplete=${String(shutdownComplete)}, timedOut=${String(timedOut)}`
      + `${stderr === '' ? '' : `\n${stderr}`}`,
    )
  }
} finally {
  clearTimeout(timeout)
  rmSync(harnessHome, { recursive: true, force: true })
}
