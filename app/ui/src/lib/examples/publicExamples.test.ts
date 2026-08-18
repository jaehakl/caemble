import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cadElementCatalog } from '@/lib/cad'
import { createExperimentSourceBundle } from '@/lib/cad/source/document'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import {
  evaluatePublicExampleBundle,
  expectReliablePublicScene,
  standalonePublicExampleBundle,
} from '@/test/publicExampleHarness'
import { caembleExamples, geometryAuthoringSkeletonSourceBundle } from '.'

const experimentProgramGuide = readFileSync(
  new URL('../../../../../docs/experiment-program.md', import.meta.url),
  'utf8',
)

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

  it('evaluates the complete source bundle published in the standalone Experiment guide', async () => {
    const tsxSources = [...experimentProgramGuide.matchAll(/```tsx\r?\n([\s\S]*?)```/gu)].map((match) => match[1])
    const pythonSource = /```python\r?\n([\s\S]*?)```/u.exec(experimentProgramGuide)?.[1]
    expect(tsxSources).toHaveLength(4)
    expect(pythonSource).toBeDefined()

    const result = await evaluatePublicExampleBundle(
      createExperimentSourceBundle({
        'geometry.tsx': tsxSources[0],
        'experiment.tsx': tsxSources[1],
        'material.tsx': tsxSources[2],
        'tasks/electric.tsx': tsxSources[3],
        'simulate.py': pythonSource!,
      }),
    )

    expectReliablePublicScene(result.scene)
    expectReliablePublicScene(result.taskScenes.electric)
  })
})
