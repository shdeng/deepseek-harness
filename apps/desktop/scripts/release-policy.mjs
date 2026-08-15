/** Packages that a DeepSeek-only Desktop release must never build or deploy. */
export const FORBIDDEN_RELEASE_PACKAGES = new Set([
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@aws-sdk/client-bedrock-runtime',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-web-frontend',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-subagent-claude-code',
  '@deepseek-ai/dsh-subagent-codex',
  '@earendil-works/pi-ai',
  '@google/genai',
  '@mistralai/mistralai',
  '@openai/codex',
  'openai',
])

/** Return whether a package belongs to an excluded provider or agent SDK family. */
export function isForbiddenReleasePackage(packageName) {
  return FORBIDDEN_RELEASE_PACKAGES.has(packageName)
    || packageName.startsWith('@openai/codex-')
    || packageName.startsWith('@anthropic-ai/claude-agent-sdk-')
}

/**
 * List required DeepSeek peer packages absent from a deployed package set.
 * @param {readonly {
 *   name?: string,
 *   peerDependencies?: Record<string, string>,
 *   peerDependenciesMeta?: Record<string, { optional?: boolean }>,
 * }[]} manifests Deployed package manifests.
 * @returns {{ owner: string, dependency: string }[]} Missing peer relationships.
 */
export function findMissingInternalPeers(manifests) {
  const deployed = new Set(manifests.map(manifest => manifest.name).filter(name => typeof name === 'string'))
  const missing = new Map()

  for (const manifest of manifests) {
    if (typeof manifest.name !== 'string') continue
    for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
      if (!dependency.startsWith('@deepseek-ai/')) continue
      if (manifest.peerDependenciesMeta?.[dependency]?.optional === true) continue
      if (deployed.has(dependency)) continue
      missing.set(`${manifest.name}\0${dependency}`, { owner: manifest.name, dependency })
    }
  }

  return [...missing.values()].sort((left, right) =>
    left.owner.localeCompare(right.owner) || left.dependency.localeCompare(right.dependency),
  )
}
