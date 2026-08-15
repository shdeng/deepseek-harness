import { describe, expect, it } from 'vitest'
import { findMissingInternalPeers, isForbiddenReleasePackage } from '../scripts/release-policy.mjs'

describe('Desktop release package policy', () => {
  it.each([
    '@anthropic-ai/claude-agent-sdk',
    '@anthropic-ai/sdk',
    '@aws-sdk/client-bedrock-runtime',
    '@earendil-works/pi-ai',
    '@google/genai',
    '@mistralai/mistralai',
    '@openai/codex-win32-x64',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-web-frontend',
    'openai',
  ])('rejects %s', (packageName) => {
    expect(isForbiddenReleasePackage(packageName)).toBe(true)
  })

  it('allows the native DeepSeek provider', () => {
    expect(isForbiddenReleasePackage('@deepseek-ai/dsh-llm-deepseek')).toBe(false)
  })

  it('reports required internal peers missing from the deployed package set', () => {
    expect(findMissingInternalPeers([
      {
        name: '@deepseek-ai/dsh-consumer',
        peerDependencies: {
          '@deepseek-ai/dsh-required': 'workspace:^',
          '@deepseek-ai/dsh-optional': 'workspace:^',
          'third-party-peer': '^1.0.0',
        },
        peerDependenciesMeta: {
          '@deepseek-ai/dsh-optional': { optional: true },
        },
      },
    ])).toEqual([
      {
        owner: '@deepseek-ai/dsh-consumer',
        dependency: '@deepseek-ai/dsh-required',
      },
    ])
  })

  it('accepts an installed required internal peer', () => {
    expect(findMissingInternalPeers([
      {
        name: '@deepseek-ai/dsh-consumer',
        peerDependencies: { '@deepseek-ai/dsh-required': 'workspace:^' },
      },
      { name: '@deepseek-ai/dsh-required' },
    ])).toEqual([])
  })
})
