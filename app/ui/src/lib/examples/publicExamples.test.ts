import { describe, expect, it } from 'vitest'
import { cadElementCatalog } from '@/lib/cad'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import {
  evaluatePublicExampleBundle,
  expectReliablePublicScene,
  standalonePublicExampleBundle,
} from '@/test/publicExampleHarness'
import { caembleExamples, geometryAuthoringSkeletonSourceBundle } from '.'

installSyntheticCatalog({
  quantityKinds: [
    { name: 'DimensionlessRatio', applicableUnits: ['{fraction}'] },
    { name: 'electromagnetism.ElectricCurrent', applicableUnits: ['A'] },
    { name: 'electromagnetism.Voltage', applicableUnits: ['mV'] },
    { name: 'electromagnetism.ElectricConductivity', tensorOrder: 2, applicableUnits: ['S.m-1'] },
  ],
  materialParameters: [{ key: 'electrical.conductivity', quantityKind: 'electromagnetism.ElectricConductivity' }],
})

describe('public CAD examples', () => {
  it('keeps every public example id unique', () => {
    expect(new Set(caembleExamples.map(({ id }) => id)).size).toBe(caembleExamples.length)
  })

  it.each(caembleExamples)('compiles and evaluates the $title example into a reliable scene', async (example) => {
    const bundle =
      example.id === 'dc-conductor' ? defaultExperimentSourceBundle : standalonePublicExampleBundle(example.code)
    const result = await evaluatePublicExampleBundle(bundle)

    expectReliablePublicScene(result.scene)
  })

  it.each(cadElementCatalog)('compiles and evaluates the <$tag> manifest example', async (manifest) => {
    const bundle = standalonePublicExampleBundle(`import { experiment } from '@caemble/core'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => (${manifest.example}),
  recordedData: {},
})
`)
    const result = await evaluatePublicExampleBundle(bundle)

    expectReliablePublicScene(result.scene)
  })

  it('keeps the AI Helper complete geometry skeleton executable', async () => {
    const result = await evaluatePublicExampleBundle(geometryAuthoringSkeletonSourceBundle)

    expect(result.scene.parts.map(({ id }) => id)).toEqual(['assembly.base', 'assembly.post'])
    expectReliablePublicScene(result.scene)
  })
})
