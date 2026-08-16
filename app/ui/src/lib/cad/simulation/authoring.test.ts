import { describe, expect, it } from 'vitest'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { simulationProgramManifest } from './authoring'

installSyntheticCatalog({
  quantityKinds: [
    { name: 'electromagnetism.ElectricCurrentDensity', tensorOrder: 1, applicableUnits: ['A.m-2'] },
  ],
})

describe('simulationProgramManifest', () => {
  it('canonicalizes RecordedData and includes its UI-resolved tensor order', () => {
    const manifest = simulationProgramManifest(
      {},
      {
        currentDensity: {
          dtype: 'float64',
          unit: 'A.m-2',
          quantityKind: 'electromagnetism.ElectricCurrentDensity',
        },
      },
      'async def simulate(*, sim, tasks, vars):\n    return None\n',
    )

    expect(manifest.formatVersion).toBe(5)
    expect(manifest.simulationApiVersion).toBe(3)
    expect(manifest.recordedData.currentDensity.basis).toEqual(identityCartesianBasis)
    expect(manifest.recordedData.currentDensity.tensorOrder).toBe(1)
  })
})
