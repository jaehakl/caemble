import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { evaluatePublicExampleBundle, expectReliablePublicScene } from '@/test/publicExampleHarness'
import { draftTaskCode, starterExperimentSourceBundle } from './localExperimentCode'

describe('local Experiment templates', () => {
  it('evaluates the Starter through geometry.tsx into a small 3D solid', async () => {
    const result = await evaluatePublicExampleBundle(starterExperimentSourceBundle)

    expect(starterExperimentSourceBundle.files['experiment.tsx']).toContain("from './geometry'")
    expect(result.scene.parts).toHaveLength(1)
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
    expectReliablePublicScene(result.scene)
    expectReliablePublicScene(result.taskScenes.main, { allowEmpty: true })
  })

  it('keeps every required Starter file and a Solver-independent draft Task', () => {
    expect(Object.keys(starterExperimentSourceBundle.files)).toEqual([
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'simulate.py',
      'tasks/main.tsx',
    ])
    expect(starterExperimentSourceBundle.files['tasks/main.tsx']).toBe(draftTaskCode)
    expect(draftTaskCode).toContain("name: 'replace-with-solver'")
    expect(draftTaskCode).not.toContain('dc-current-density')
  })
})
