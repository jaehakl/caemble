import { describe, expect, it } from 'vitest'
import aiManifestSource from '../../../../slaves/ai/manifest.json?raw'
import caeManifestSource from '../../../../slaves/cae/manifest.json?raw'
import { bundledSlaveManifests } from './manifests'

describe('bundledSlaveManifests', () => {
  it('exposes the complete canonical AI and CAE manifests without generated copies', () => {
    const expected = [JSON.parse(aiManifestSource), JSON.parse(caeManifestSource)].sort((left, right) =>
      left.id.localeCompare(right.id),
    )

    expect(bundledSlaveManifests).toEqual(expected)
    expect(bundledSlaveManifests).toEqual([
      {
        id: 'ai',
        name: 'AI',
        module: 'app',
        startup_timeout_seconds: 300,
      },
      {
        id: 'cae',
        name: 'CAE',
        module: 'app',
        startup_timeout_seconds: 60,
      },
    ])
    expect(Object.isFrozen(bundledSlaveManifests)).toBe(true)
    expect(bundledSlaveManifests.every((manifest) => Object.isFrozen(manifest))).toBe(true)
  })
})
