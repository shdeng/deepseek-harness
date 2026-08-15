import { describe, expect, it } from 'vitest'
import { resolveProfileTemplate } from '../src/profile-boot.ts'

describe('desktop profile template', () => {
  it('owns a no-listener desktop profile template', () => {
    expect(resolveProfileTemplate('desktop', '1')).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-gui-app',
      '@deepseek-ai/dsh-desktop-app',
    ])
    expect(resolveProfileTemplate('web', '1')).toBeUndefined()
    expect(resolveProfileTemplate('headless', '1')).toBeUndefined()
  })

  it('rejects malformed supervisor configuration', () => {
    expect(() => resolveProfileTemplate('desktop', 'true')).toThrow('DSH_DESKTOP_SIDECAR')
  })
})
