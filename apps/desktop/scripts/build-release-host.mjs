import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { isForbiddenReleasePackage } from './release-policy.mjs'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appDir, '..', '..')
const runtimeManifestPath = path.join(repoRoot, 'apps', 'desktop-runtime', 'package.json')

const readJson = (filename) => JSON.parse(readFileSync(filename, 'utf8'))

const workspaceManifests = new Map()
for (const parent of ['vendor', 'apps']) {
  const directory = path.join(repoRoot, parent)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const filename = path.join(directory, entry.name, 'package.json')
    if (!existsSync(filename)) continue
    const manifest = readJson(filename)
    workspaceManifests.set(manifest.name, manifest)
  }
}
for (const group of readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  const directory = path.join(repoRoot, 'packages', group.name)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const filename = path.join(directory, entry.name, 'package.json')
    if (!existsSync(filename)) continue
    const manifest = readJson(filename)
    workspaceManifests.set(manifest.name, manifest)
  }
}

const runtimeManifest = readJson(runtimeManifestPath)
const releasePackages = new Set()
const queue = Object.keys(runtimeManifest.dependencies ?? {})
for (let packageName = queue.shift(); packageName !== undefined; packageName = queue.shift()) {
  if (releasePackages.has(packageName)) continue
  releasePackages.add(packageName)
  const manifest = workspaceManifests.get(packageName)
  if (manifest === undefined) continue
  queue.push(...Object.keys(manifest.dependencies ?? {}))
  queue.push(...Object.keys(manifest.peerDependencies ?? {}).filter(
    dependency => manifest.peerDependenciesMeta?.[dependency]?.optional !== true,
  ))
}

const forbidden = [...releasePackages].filter(isForbiddenReleasePackage)
if (forbidden.length > 0) {
  throw new Error(`desktop build closure contains forbidden packages:\n${forbidden.sort().join('\n')}`)
}

const runNode = (script, args, cwd = repoRoot) => {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(script)} failed with status ${result.status ?? 'unknown'}`)
  }
}

const typescript = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const tsdown = path.join(repoRoot, 'node_modules', 'tsdown', 'dist', 'run.mjs')
const vite = path.join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js')

runNode(typescript, ['-b', 'packages/typert/generator', 'apps/cli/tsconfig.desktop.json'])
runNode(typescript, ['-b', 'apps/web/tsconfig.json'])

releasePackages.add('@deepseek-ai/dsh')
const packageFilters = [...releasePackages]
  .filter(packageName => workspaceManifests.has(packageName) || packageName === '@deepseek-ai/dsh')
  .flatMap(packageName => ['--filter', packageName])
runNode(tsdown, ['--env.DSH_BUILD_FACE', 'host', ...packageFilters])
runNode(tsdown, ['--env.DSH_BUILD_FACE', 'client', ...packageFilters])
runNode(vite, ['build'], path.join(repoRoot, 'apps', 'web'))
