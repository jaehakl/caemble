import { describe, expect, it } from 'vitest'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { simulationProgramManifest } from './authoring'

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
      'async def simulate(*, sim, tasks, vars, world):\n    return None\n',
    )

    expect(manifest.formatVersion).toBe(3)
    expect(manifest.recordedData.currentDensity.basis).toEqual(identityCartesianBasis)
    expect(manifest.recordedData.currentDensity.tensorOrder).toBe(1)
  })
})
