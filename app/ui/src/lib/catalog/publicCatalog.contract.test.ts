import { describe, expect, it, vi } from 'vitest'
import { experimentDetailSchema } from '@/contracts/catalog'
import { scenePartColor } from '@/features/viewer/viewer/materialColor'
import { assertSimulationProgramManifest } from '@/lib/cad/simulation'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { generateRandomVars, type Tensor, type Vars } from '@/lib/cad'
import {
  evaluatePublicExampleBundle,
  expectReliablePublicScene,
  inspectPublicExampleBundle,
} from '@/test/publicExampleHarness'
import { exampleExperiment, exampleExperimentKeys } from './catalogTestData'

installSyntheticCatalog({
  quantityKinds: [
    { name: 'DimensionlessRatio', applicableUnits: ['{fraction}'] },
    { name: 'Length', applicableUnits: ['m'] },
    { name: 'electromagnetism.ElectricCurrent', applicableUnits: ['A'] },
    { name: 'electromagnetism.ElectricCurrentDensity', tensorOrder: 1, applicableUnits: ['A.m-2'] },
    { name: 'electromagnetism.Voltage', applicableUnits: ['mV'] },
    { name: 'electromagnetism.ElectricConductivity', tensorOrder: 2, applicableUnits: ['S.m-1'] },
    { name: 'synthetic.ThermalConductivity', tensorOrder: 2, applicableUnits: ['W.m-1.K-1'] },
    { name: 'thermodynamics.Temperature', applicableUnits: ['K'] },
  ],
  materialParameters: [
    { key: 'electrical.conductivity', quantityKind: 'electromagnetism.ElectricConductivity' },
    { key: 'thermal.conductivity', quantityKind: 'synthetic.ThermalConductivity' },
  ],
})

function filledTensor(shape: readonly number[], value: number): Tensor {
  if (shape.length === 0) return value
  return Array.from({ length: shape[0] }, () => filledTensor(shape.slice(1), value))
}

describe('canonical public Experiment catalog', () => {
  it('accepts fixture objects, explicit null, and omitted fixture fields from catalog transports', () => {
    const withFixture = exampleExperiment('dc-uniform-bar')
    const withAssertions = exampleExperiment('fiber-bundle')
    const withoutFixture = exampleExperiment('dc-notched-current-density')

    expect(experimentDetailSchema.parse(withFixture).verification.fixture).toMatchObject({
      records: [{ name: 'totalCurrent' }],
    })
    expect(experimentDetailSchema.parse(withAssertions).verification.fixture).toMatchObject({
      records: [
        { name: 'currentDensity', shape: [31, 31, 3], finite: true, nonzero: true },
        { name: 'totalCurrent', shape: [], finite: true, minimumExclusive: 0 },
      ],
    })
    expect(experimentDetailSchema.parse(withoutFixture).verification.fixture).toBeUndefined()
    expect(
      experimentDetailSchema.parse({
        ...withoutFixture,
        verification: { ...withoutFixture.verification, fixture: null },
      }).verification.fixture,
    ).toBeNull()
  })

  it('rejects mixed, empty assertion, and unknown fixture record fields', () => {
    const item = exampleExperiment('fiber-bundle')
    const [currentDensity] = item.verification.fixture!.records
    const invalidRecords = [
      { ...currentDensity, value: [], absoluteTolerance: 0 },
      { name: 'currentDensity', dtype: 'float64', shape: [31, 31, 3] },
      { ...currentDensity, unexpected: true },
    ]

    invalidRecords.forEach((record) =>
      expect(() =>
        experimentDetailSchema.parse({
          ...item,
          verification: {
            ...item.verification,
            fixture: { ...item.verification.fixture, records: [record] },
          },
        }),
      ).toThrow(),
    )
  })

  it('keeps historical catalog versions readable while API 11 versions use numeric surfaces', () => {
    const legacy = exampleExperiment('dc-uniform-bar', '1.0.0')
    const semantic = exampleExperiment('dc-uniform-bar', '2.0.0')
    const current = exampleExperiment('dc-uniform-bar', '3.0.0')

    for (const cadApiVersion of [7, 8, 9, 10, 11] as const) {
      expect(experimentDetailSchema.parse({ ...legacy, cadApiVersion }).cadApiVersion).toBe(cadApiVersion)
    }
    for (const cadApiVersion of [6, 12]) {
      expect(() => experimentDetailSchema.parse({ ...legacy, cadApiVersion })).toThrow()
    }
    expect(experimentDetailSchema.parse(legacy).cadApiVersion).toBe(9)
    expect(legacy.sourceBundle.files['experiment.tsx']).toContain('conductor.box/surface-1')
    expect(experimentDetailSchema.parse(semantic).cadApiVersion).toBe(10)
    expect(semantic.sourceBundle.files['experiment.tsx']).toContain('conductor.body/surface/%2BX')
    expect(experimentDetailSchema.parse(current).cadApiVersion).toBe(11)
    expect(current.sourceBundle.files['experiment.tsx']).toContain('conductor.body/surface/1')
    expect(current.sourceBundle.files['experiment.tsx']).not.toMatch(/\/surface-[0-9]/u)
  })

  it.each(exampleExperimentKeys)('validates %s bundle, tasks, RecordedData, and verification', async (key) => {
    const item = exampleExperiment(key)
    const result = await evaluatePublicExampleBundle(item.sourceBundle)
    const manifest = result.simulationProgram

    expect(item.cadApiVersion).toBe(11)
    expect(item.sourceFormatVersion).toBe(2)
    expect(item.bundleFormatVersion).toBe(6)
    expect(manifest).toMatchObject({
      formatVersion: 5,
      simulationApiVersion: 3,
      pythonSource: item.sourceBundle.files['simulate.py'],
    })
    expect(Object.keys(manifest.tasks)).toEqual(item.verification.kernelTasks)
    expect(Object.keys(manifest.recordedData)).toEqual(item.verification.recordedData)
    expect(() => assertSimulationProgramManifest(manifest, { allowTaskless: true })).not.toThrow()
    if (item.verification.kernelTasks.length === 0) {
      expect(() => assertSimulationProgramManifest(manifest)).toThrow()
    } else {
      expect(() => assertSimulationProgramManifest(manifest)).not.toThrow()
    }
    expect(Object.keys(item.sourceBundle.files).filter((path) => path.startsWith('tasks/'))).toHaveLength(
      item.verification.kernelTasks.length,
    )
    expectReliablePublicScene(result.scene)
    Object.values(result.taskScenes).forEach((scene) => expectReliablePublicScene(scene))
  })

  it.each(exampleExperimentKeys)('evaluates %s at min, midpoint, max, and alternating geometry bounds', async (key) => {
    const bundle = exampleExperiment(key).sourceBundle
    const { inspection } = inspectPublicExampleBundle(bundle)
    expect(
      Object.values(inspection.varsSchema).some(({ min, max }) => JSON.stringify(min) !== JSON.stringify(max)),
    ).toBe(true)

    const minimum = Object.fromEntries(
      Object.entries(inspection.varsSchema).map(([name, entry]) => [name, filledTensor(entry.shape, entry.min)]),
    ) as Vars
    const maximum = Object.fromEntries(
      Object.entries(inspection.varsSchema).map(([name, entry]) => [name, filledTensor(entry.shape, entry.max)]),
    ) as Vars
    const generated: Vars[] = []
    for (const sampler of [
      () => 0.5,
      (() => {
        let index = 0
        return () => (index++ % 2 === 0 ? 0 : 1 - Number.EPSILON)
      })(),
    ]) {
      const random = vi.spyOn(Math, 'random').mockImplementation(sampler)
      generated.push(generateRandomVars(inspection.varsSchema))
      random.mockRestore()
    }
    for (const [candidate, variables] of [
      ['minimum', minimum],
      ['midpoint', generated[0]],
      ['alternating', generated[1]],
      ['maximum', maximum],
    ] as const) {
      const result = await evaluatePublicExampleBundle(bundle, variables)
      try {
        expectReliablePublicScene(result.scene)
        Object.values(result.taskScenes).forEach((scene) => expectReliablePublicScene(scene))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`${key} ${candidate} Candidate is not reliable: ${JSON.stringify(variables)}; cause: ${detail}`)
      }
    }
  })

  it('uses explicit array shapes and scalar bounds for every per-cell variable', () => {
    const cases = [
      {
        key: 'random-curved-edge-cylinder-array' as const,
        scalarShape: [4, 4, 1],
      },
      {
        key: 'random-curved-surface-sphere-hcp-array' as const,
        scalarShape: [4, 4, 3],
      },
    ]

    cases.forEach(({ key, scalarShape }) => {
      const bundle = exampleExperiment(key).sourceBundle
      const schema = inspectPublicExampleBundle(bundle).inspection.varsSchema
      Object.entries(schema)
        .filter(([name]) => name.startsWith('cell'))
        .forEach(([name, entry]) => {
          expect(entry.shape, `${key}.${name}.shape`).toEqual(scalarShape)
          expect(typeof entry.min, `${key}.${name}.min`).toBe('number')
          expect(typeof entry.max, `${key}.${name}.max`).toBe('number')
          expect(entry.min).not.toEqual(entry.max)
        })
      expect(bundle.files['experiment.tsx']).not.toMatch(/cell(?:Vector)?Tensor/u)
    })
  })

  it('preserves wheel Material roles and gives them distinct automatic Viewer colors', async () => {
    const result = await evaluatePublicExampleBundle(exampleExperiment('two-material-wheel-assembly').sourceBundle)
    expect(result.scene.parts.map(({ materialRole }) => materialRole)).toEqual(['tire', 'wheel'])
    expect(new Set(result.scene.parts.map(scenePartColor)).size).toBe(2)
  })

  it.each(exampleExperimentKeys)('keeps %s orchestration in the Python v3 ABI', (key) => {
    const item = exampleExperiment(key)
    const source = item.sourceBundle.files['simulate.py']
    expect(item.sourceBundle.files['experiment.tsx']).not.toContain('sim.run(')
    expect(source).toMatch(/^async def simulate\(\*, sim, tasks, vars\):/u)
    expect(source).not.toContain('world')
    item.verification.kernelTasks.forEach((task) => expect(source).toContain(`tasks["${task}"]`))
    item.verification.recordedData.forEach((name) =>
      expect(source).toMatch(new RegExp(`await\\s+sim\\.record\\(\\s*["']${name}["']`, 'u')),
    )
  })
})
