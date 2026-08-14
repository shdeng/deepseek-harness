/** Packages that a DeepSeek-only Desktop release must never build or deploy. */
export const FORBIDDEN_RELEASE_PACKAGES = new Set([
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@aws-sdk/client-bedrock-runtime',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
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
