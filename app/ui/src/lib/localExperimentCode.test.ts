import { geometries, measurements } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import { evaluatePublicExampleBundle, expectReliablePublicScene } from '@/test/publicExampleHarness'
import { wheelAssemblySourceBundle } from './examples/wheelAssembly'
import { blankExperimentSourceBundle, starterExperimentSourceBundle } from './localExperimentCode'

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

  it('keeps every required file in Blank and evaluates to an empty Scene', async () => {
    const result = await evaluatePublicExampleBundle(blankExperimentSourceBundle)

    expect(Object.keys(blankExperimentSourceBundle.files)).toEqual([
      'experiment.tsx',
      'geometry.tsx',
      'material.tsx',
      'simulate.py',
      'tasks/main.tsx',
    ])
    expect(blankExperimentSourceBundle.files['geometry.tsx']).toContain("from '@caemble/core'")
    expect(blankExperimentSourceBundle.files['simulate.py']).toContain('Replace this no-op body')
    expect(blankExperimentSourceBundle.files['tasks/main.tsx']).toContain('Draft preview only')
    expect(result.scene.parts).toHaveLength(0)
    expectReliablePublicScene(result.scene, { allowEmpty: true })
    expectReliablePublicScene(result.taskScenes.main, { allowEmpty: true })
  })

  it('inherits and remaps the two Wheel Assembly Material roles', async () => {
    const result = await evaluatePublicExampleBundle(wheelAssemblySourceBundle)

    expect(result.scene.parts.map(({ material, materialRole }) => [materialRole, material?.name])).toEqual([
      ['tire', 'Rubber'],
      ['wheel', 'Aluminum'],
    ])
    expect(result.scene.parts.every((part) => part.material?.variables.color === undefined)).toBe(true)
    expectReliablePublicScene(result.scene)
    expectReliablePublicScene(result.taskScenes.main)
  })
})
