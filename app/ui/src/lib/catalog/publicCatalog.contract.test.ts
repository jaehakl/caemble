import { describe, expect, it } from 'vitest'
import { experimentDetailSchema } from '@/contracts/catalog'
import { scenePartColor } from '@/features/viewer/viewer/materialColor'
import { assertSimulationProgramManifest } from '@/lib/cad/simulation'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { evaluatePublicExampleBundle, expectReliablePublicScene } from '@/test/publicExampleHarness'
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
    const withoutFixture = exampleExperiment('dc-notched-current-density')

    expect(experimentDetailSchema.parse(withFixture).verification.fixture).toMatchObject({
      records: [{ name: 'totalCurrent' }],
    })
    expect(experimentDetailSchema.parse(withoutFixture).verification.fixture).toBeUndefined()
    expect(
      experimentDetailSchema.parse({
        ...withoutFixture,
        verification: { ...withoutFixture.verification, fixture: null },
      }).verification.fixture,
    ).toBeNull()
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
