import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { resolveProfileTemplate } from '../src/profile-boot.ts'

const bundlePatch = (group: string, name: string): string =>
  fileURLToPath(new URL(`../../../packages/${group}/${name}/cordis.patch.yml`, import.meta.url))

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

  it('replaces file credentials with the system-vault provider without a skipped rename patch', () => {
    const warnings: string[] = []
    const rows = composeEntries([
      loadOverlayPatches('desktop-profile-test', bundlePatch('bundle', 'base')),
      loadOverlayPatches('desktop-profile-test', bundlePatch('bundle', 'gui-app')),
      loadOverlayPatches('desktop-profile-test', bundlePatch('bundle', 'desktop-app')),
    ], (line) => { warnings.push(line) })

    expect(warnings).toEqual([])
    expect(rows.find(row => row.id === 'credentials')).toMatchObject({
      name: '@deepseek-ai/dsh-credentials-local',
      disabled: true,
    })
    expect(rows.find(row => row.id === 'credentials-system')).toMatchObject({
      name: '@deepseek-ai/dsh-credentials-system',
    })
  })
})
