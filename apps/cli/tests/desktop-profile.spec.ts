import { describe, expect, it } from 'vitest'
import { resolveProfileTemplate } from '../src/profile-boot.ts'

describe('desktop profile template', () => {
  it('keeps the web profile name while excluding optional provider bundles', () => {
    expect(resolveProfileTemplate('web', '1')).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ])
    expect(resolveProfileTemplate('headless', '1')).toBeUndefined()
  })

  it('rejects malformed supervisor configuration', () => {
    expect(() => resolveProfileTemplate('web', 'true')).toThrow('DSH_DESKTOP_SIDECAR')
  })
})
