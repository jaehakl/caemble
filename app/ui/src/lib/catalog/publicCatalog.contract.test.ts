import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { scenePartColor } from '@/features/viewer/viewer/materialColor'
import { cadElementCatalog } from '@/lib/cad'
import { assertSimulationProgramManifest } from '@/lib/cad/simulation'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import {
  evaluatePublicExampleBundle,
  expectReliablePublicScene,
  standaloneGeometryBundle,
} from '@/test/publicExampleHarness'
import { officialExperiment, officialExperimentKeys, officialGeometry, officialGeometryKeys } from './catalogTestData'

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

describe('canonical public Geometry catalog', () => {
  it.each(officialGeometryKeys)('compiles and evaluates %s as a CAD API v8 named export', async (key) => {
    const item = officialGeometry(key)
    const sourceHash = createHash('sha256').update(item.source, 'utf8').digest('hex')
    const result = await evaluatePublicExampleBundle(
      standaloneGeometryBundle(item.source, item.exportName, item.lengthUnit),
    )

    expect(item.cadApiVersion).toBe(8)
    expect(item.moduleFormatVersion).toBe(4)
    expect(sourceHash).toBe(item.sourceHash)
    expectReliablePublicScene(result.scene)
    const knownTags = new Set(cadElementCatalog.map((element) => element.tag))
    item.relatedElements.forEach((element) => expect(knownTags).toContain(element))
  })

  it('preserves wheel Material roles and gives them distinct automatic Viewer colors', async () => {
    const item = officialGeometry('two-material-wheel-assembly')
    const result = await evaluatePublicExampleBundle(
      standaloneGeometryBundle(item.source, item.exportName, item.lengthUnit),
    )
    expect(item.materialRoles.map(({ role }) => role)).toEqual(['tire', 'wheel'])
    expect(result.scene.parts.map(({ materialRole }) => materialRole)).toEqual(['tire', 'wheel'])
    expect(new Set(result.scene.parts.map(scenePartColor)).size).toBe(2)
  })
})

describe('canonical public Experiment catalog', () => {
  it.each(officialExperimentKeys)('validates %s bundle, tasks, RecordedData, and verification', async (key) => {
    const item = officialExperiment(key)
    const result = await evaluatePublicExampleBundle(item.sourceBundle)
    const manifest = result.simulationProgram

    expect(item.cadApiVersion).toBe(8)
    expect(item.sourceFormatVersion).toBe(2)
    expect(item.bundleFormatVersion).toBe(5)
    expect(manifest).toMatchObject({
      formatVersion: 5,
      simulationApiVersion: 3,
      pythonSource: item.sourceBundle.files['simulate.py'],
    })
    expect(Object.keys(manifest.tasks)).toEqual(item.verification.kernelTasks)
    expect(Object.keys(manifest.recordedData)).toEqual(item.verification.recordedData)
    expect(() => assertSimulationProgramManifest(manifest)).not.toThrow()
    expect(Object.keys(item.sourceBundle.files).filter((path) => path.startsWith('tasks/'))).toHaveLength(
      item.verification.kernelTasks.length,
    )
    expectReliablePublicScene(result.scene)
    Object.values(result.taskScenes).forEach((scene) => expectReliablePublicScene(scene))
  })

  it.each(officialExperimentKeys)('keeps %s orchestration in the Python v3 ABI', (key) => {
    const item = officialExperiment(key)
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
