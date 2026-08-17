import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createInterface } from 'node:readline'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resourcesDir = path.join(appDir, 'src-tauri', 'release-resources')
const hostDir = path.join(resourcesDir, 'host')
const node = path.join(resourcesDir, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
const credentialLibrary = path.join(
  resourcesDir,
  'runtime',
  process.platform === 'win32'
    ? 'dsh_credential_store.dll'
    : process.platform === 'darwin' ? 'libdsh_credential_store.dylib' : 'libdsh_credential_store.so',
)
const cli = path.join(hostDir, 'lib', 'bin.js')
const harnessHome = mkdtempSync(path.join(tmpdir(), 'dsh-desktop-release-smoke-'))
const timeoutMs = 30_000

const child = spawn(node, [
  '--expose-internals',
  cli,
  '--profile', 'desktop',
], {
  cwd: hostDir,
  env: {
    ...process.env,
    DSH_DESKTOP_SIDECAR: '1',
    DSH_SHUTDOWN_ON_STDIN_EOF: '1',
    DSH_HOME: harnessHome,
    DSH_DESKTOP_CREDENTIAL_LIBRARY: credentialLibrary,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let started = false
let shutdownComplete = false
let assetRead = false
let unaryCall = false
let failure
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
  if (!line.startsWith('DSH-IPC/1 ')) {
    process.stdout.write(`${line}\n`)
    return
  }
  const frame = JSON.parse(line.slice('DSH-IPC/1 '.length))
  if (frame.kind === 'native-request' && frame.request?.op === 'metadata') {
    child.stdin.write(`DSH-IPC/1 ${JSON.stringify({
      v: 1,
      kind: 'native-response',
      id: frame.id,
      result: {
        name: 'DeepSeek Harness Desktop',
        version: '0.4.0',
        identifier: 'ai.deepseek.harness.desktop',
      },
    })}\n`)
    return
  }
  if (!(frame.kind === 'response' && frame.id === 'release-asset')) {
    process.stdout.write(`${line}\n`)
  }
  if (!started && frame.kind === 'ready') {
    const entry = frame.manifest?.entries?.[0]
    const asset = typeof entry?.url === 'string'
      ? /^dsh-plugin:\/\/localhost\/([a-f0-9]{64})\/client\.js(?:\?|$)/.exec(entry.url)?.[1]
      : undefined
    if (asset === undefined) {
      failure = new Error('packaged Host ready frame has no valid custom-protocol client asset')
      child.kill('SIGKILL')
      return
    }
    if (process.platform === 'win32') {
      const sockets = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-NetTCPConnection -State Listen -OwningProcess ${String(child.pid)} -ErrorAction SilentlyContinue | Measure-Object).Count`,
      ], { encoding: 'utf8' })
      if (sockets.status !== 0 || Number(sockets.stdout.trim()) !== 0) {
        failure = new Error(`packaged Desktop Host opened a listening socket: ${sockets.stdout.trim()}`)
        child.kill('SIGKILL')
        return
      }
    }
    started = true
    child.stdin.write(`DSH-IPC/1 ${JSON.stringify({
      v: 1,
      kind: 'request',
      request: { op: 'asset-read', id: 'release-asset', asset },
    })}\n`)
  } else if (frame.kind === 'response' && frame.id === 'release-asset') {
    assetRead = typeof frame.result?.body === 'string' && frame.result.body.length > 0
    child.stdin.write(`DSH-IPC/1 ${JSON.stringify({
      v: 1,
      kind: 'request',
      request: {
        op: 'fetch',
        id: 'release-unary',
        path: '/api/host.describe',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'release-unary-rpc',
          method: 'host.describe',
          payload: {},
        }),
      },
    })}\n`)
  } else if (frame.kind === 'response' && frame.id === 'release-unary') {
    const body = typeof frame.result?.body === 'string' ? JSON.parse(frame.result.body) : undefined
    unaryCall = frame.result?.status === 200
      && body?.type === 'server-response'
      && body?.rpcId === 'release-unary-rpc'
      && body?.result?.ok === true
    child.stdin.write('DSH-IPC/1 {"v":1,"kind":"shutdown","id":"release-smoke"}\n')
  } else if (frame.kind === 'shutdown-complete') {
    shutdownComplete = true
  }
})

try {
  const [code] = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (...args) => resolve(args))
  })
  if (failure !== undefined) throw failure
  if (code !== 0 || !started || !assetRead || !unaryCall || !shutdownComplete) {
    throw new Error(
      `packaged Host smoke failed: exit=${String(code)}, started=${String(started)}, `
      + `assetRead=${String(assetRead)}, unaryCall=${String(unaryCall)}, `
      + `shutdownComplete=${String(shutdownComplete)}, timedOut=${String(timedOut)}`
      + `${stderr === '' ? '' : `\n${stderr}`}`,
    )
  }
} finally {
  clearTimeout(timeout)
  rmSync(harnessHome, { recursive: true, force: true })
}
