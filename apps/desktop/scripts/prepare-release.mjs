import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appDir, '..', '..')
const resourcesDir = path.join(appDir, 'src-tauri', 'release-resources')
const hostDir = path.join(resourcesDir, 'host')
const runtimeDir = path.join(resourcesDir, 'runtime')

rmSync(resourcesDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })

const pnpmCli = process.env.npm_execpath
if (pnpmCli === undefined) {
  throw new Error('prepare-release must run through pnpm so npm_execpath identifies the package manager')
}
const deployed = spawnSync(
  process.execPath,
  [
    pnpmCli,
    '--filter', '@deepseek-ai/dsh',
    'deploy', hostDir,
    '--prod',
    '--legacy',
    '--config.node-linker=hoisted',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
)
if (deployed.error !== undefined) throw deployed.error
if (deployed.status !== 0) {
  throw new Error(`pnpm deploy failed with status ${deployed.status ?? 'unknown'}`)
}

const materializeLinks = (directory) => {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry)
    if (lstatSync(entryPath).isSymbolicLink()) {
      const target = realpathSync(entryPath)
      rmSync(entryPath, { recursive: true, force: true })
      cpSync(target, entryPath, { recursive: true, dereference: true })
      materializeLinks(entryPath)
    } else if (lstatSync(entryPath).isDirectory()) {
      materializeLinks(entryPath)
    }
  }
}

materializeLinks(hostDir)

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
copyFileSync(process.execPath, path.join(runtimeDir, nodeName))
writeFileSync(path.join(runtimeDir, 'VERSION'), `${process.version}\n`)
