import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { findMissingInternalPeers, isForbiddenReleasePackage } from './release-policy.mjs'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appDir, '..', '..')
const resourcesDir = path.join(appDir, 'src-tauri', 'release-resources')
const hostDir = path.join(resourcesDir, 'host')
const runtimeDir = path.join(resourcesDir, 'runtime')
const cliDir = path.join(repoRoot, 'apps', 'cli')

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
    '--filter', '@deepseek-ai/dsh-desktop-runtime',
    'deploy', hostDir,
    '--prod',
    '--config.node-linker=hoisted',
    '--config.inject-workspace-packages=true',
    '--config.strictDepBuilds=false',
  ],
  { cwd: repoRoot, stdio: 'inherit' },
)
if (deployed.error !== undefined) throw deployed.error
if (deployed.status !== 0) {
  throw new Error(`pnpm deploy failed with status ${deployed.status ?? 'unknown'}`)
}

const subprocessInstall = spawnSync(
  process.execPath,
  [path.join(
    hostDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-local',
    'scripts',
    'ensure-spawn-helper.mjs',
  )],
  { cwd: hostDir, stdio: 'inherit' },
)
if (subprocessInstall.error !== undefined) throw subprocessInstall.error
if (subprocessInstall.status !== 0) {
  throw new Error(`subprocess helper setup failed with status ${subprocessInstall.status ?? 'unknown'}`)
}

cpSync(path.join(cliDir, 'lib'), path.join(hostDir, 'lib'), { recursive: true })
cpSync(path.join(cliDir, 'config'), path.join(hostDir, 'config'), { recursive: true })

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

const forbidden = []
const deployedManifests = []
const auditPackageManifests = (directory) => {
  for (const entry of readdirSync(directory)) {
    const entryPath = path.join(directory, entry)
    if (lstatSync(entryPath).isDirectory()) {
      auditPackageManifests(entryPath)
      continue
    }
    if (entry !== 'package.json') continue
    const manifest = JSON.parse(readFileSync(entryPath, 'utf8'))
    if (typeof manifest.name !== 'string') continue
    deployedManifests.push(manifest)
    if (isForbiddenReleasePackage(manifest.name)) {
      forbidden.push(`${manifest.name} (${path.relative(hostDir, entryPath)})`)
    }
  }
}

auditPackageManifests(hostDir)
if (forbidden.length > 0) {
  throw new Error(`desktop release contains forbidden packages:\n${forbidden.sort().join('\n')}`)
}

const missingInternalPeers = findMissingInternalPeers(deployedManifests)
if (missingInternalPeers.length > 0) {
  throw new Error(
    `desktop release is missing required internal peer packages:\n${missingInternalPeers
      .map(({ owner, dependency }) => `${owner} -> ${dependency}`)
      .join('\n')}`,
  )
}

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
copyFileSync(process.execPath, path.join(runtimeDir, nodeName))
writeFileSync(path.join(runtimeDir, 'VERSION'), `${process.version}\n`)
