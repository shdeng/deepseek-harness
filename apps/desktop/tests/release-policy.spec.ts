import { describe, expect, it } from 'vitest'
import { isForbiddenReleasePackage } from '../scripts/release-policy.mjs'

describe('Desktop release package policy', () => {
  it.each([
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    '@aws-sdk/client-bedrock-runtime',
    '@earendil-works/pi-ai',
    '@google/genai',
    '@mistralai/mistralai',
    '@openai/codex-win32-x64',
    'openai',
  ])('rejects %s', (packageName) => {
    expect(isForbiddenReleasePackage(packageName)).toBe(true)
  })

  it('allows the native DeepSeek provider', () => {
    expect(isForbiddenReleasePackage('@deepseek-ai/dsh-llm-deepseek')).toBe(false)
  })
})
