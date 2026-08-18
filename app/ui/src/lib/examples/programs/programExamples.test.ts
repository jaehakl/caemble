import { describe, expect, it } from 'vitest'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { evaluatePublicExampleBundle, expectReliablePublicScene } from '@/test/publicExampleHarness'
import { assertSimulationProgramManifest } from '../../cad/simulation'
import { caembleProgramExamples } from '.'

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

describe('Python CAE Experiment examples', () => {
  it('keeps unique immutable fixtures with compact manifest v5 tasks', async () => {
    expect(new Set(caembleProgramExamples.map((example) => example.id)).size).toBe(caembleProgramExamples.length)

    for (const example of caembleProgramExamples) {
      const result = await evaluatePublicExampleBundle(example.experimentSourceBundle)
      const manifest = result.simulationProgram
      expect(manifest).toMatchObject({
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: example.experimentSourceBundle.files['simulate.py'],
      })
      expect(Object.keys(manifest.tasks)).toEqual(example.verification.kernelTasks)
      expect(Object.keys(manifest.recordedData)).toEqual(example.verification.recordedData)
      expect(() => assertSimulationProgramManifest(manifest)).not.toThrow()
      expect(
        Object.keys(example.experimentSourceBundle.files).filter((path) => path.startsWith('tasks/')),
      ).toHaveLength(example.verification.kernelTasks.length)
      expectReliablePublicScene(result.scene)
      Object.values(result.taskScenes).forEach((scene) => expectReliablePublicScene(scene))
    }
  })

  it('uses only the Python v3 ABI for orchestration and records', () => {
    caembleProgramExamples.forEach((example) => {
      const pythonSource = example.experimentSourceBundle.files['simulate.py']
      expect(example.experimentSourceBundle.files['experiment.tsx']).not.toContain('sim.run(')
      expect(pythonSource).toMatch(/^async def simulate\(\*, sim, tasks, vars\):/u)
      expect(pythonSource).not.toContain('world')
      example.verification.kernelTasks.forEach((task) => expect(pythonSource).toContain(`tasks["${task}"]`))
      example.verification.recordedData.forEach((name) =>
        expect(pythonSource).toMatch(new RegExp(`await\\s+sim\\.record\\(\\s*["']${name}["']`, 'u')),
      )
    })
  })
})
