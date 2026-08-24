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

  it.each(exampleExperimentKeys)('validates %s bundle, tasks, RecordedData, and verification', async (key) => {
    const item = exampleExperiment(key)
    const result = await evaluatePublicExampleBundle(item.sourceBundle)
    const manifest = result.simulationProgram

    expect(item.cadApiVersion).toBe(8)
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
      Object.entries(inspection.varsSchema).map(([name, entry]) => [name, entry.min]),
    ) as Vars
    const maximum = Object.fromEntries(
      Object.entries(inspection.varsSchema).map(([name, entry]) => [name, entry.max]),
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

  it('uses full array-shaped tensor bounds for every per-cell variable', () => {
    const cases = [
      {
        key: 'random-curved-edge-cylinder-array' as const,
        scalarShape: [4, 4, 1],
        vectorShape: [4, 4, 1, 3],
        vectorKeys: ['cellPosition', 'cellRotation'],
      },
      {
        key: 'random-curved-surface-sphere-hcp-array' as const,
        scalarShape: [4, 4, 3],
        vectorShape: [4, 4, 3, 3],
        vectorKeys: ['cellPositionOffsets', 'cellRotation'],
      },
    ]

    cases.forEach(({ key, scalarShape, vectorShape, vectorKeys }) => {
      const schema = inspectPublicExampleBundle(exampleExperiment(key).sourceBundle).inspection.varsSchema
      Object.entries(schema)
        .filter(([name]) => name.startsWith('cell'))
        .forEach(([name, entry]) => {
          const expectedShape = vectorKeys.includes(name) ? vectorShape : scalarShape
          const [minimumShape, maximumShape] = [entry.min, entry.max].map((value) => {
            const shape: number[] = []
            let cursor: Tensor = value
            while (Array.isArray(cursor)) {
              shape.push(cursor.length)
              cursor = cursor[0]
            }
            return shape
          })
          expect(minimumShape, `${key}.${name}.min`).toEqual(expectedShape)
          expect(maximumShape, `${key}.${name}.max`).toEqual(expectedShape)
          expect(entry.min).not.toEqual(entry.max)
        })
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
