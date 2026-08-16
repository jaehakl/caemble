import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from './cad/compiler/types'
import { executeCompiledDocument, inspectCompiledDocument } from './cad/execution/userModule'
import { generateRandomVars } from './cad/model/vars'
import {
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
} from './cad/source/sourceAnalysis'
import { wheelAssemblySourceBundle } from './examples/wheelAssembly'
import { blankExperimentSourceBundle, starterExperimentSourceBundle } from './localExperimentCode'

async function evaluate(bundle: typeof starterExperimentSourceBundle) {
  const sourceHash = '8'.repeat(64)
  const sources = await Promise.all(
    Object.entries(bundle.files)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(async ([entryFile, source]) => {
        if (entryFile === 'experiment.tsx') analyzeCadSource(source)
        else if (entryFile === 'geometry.tsx') analyzeGeometrySource(source, { allowEmpty: true })
        else if (entryFile === 'material.tsx') analyzeMaterialSource(source)
        else analyzeTaskSource(source)
        const compiled: CompiledCadSource = {
          apiVersion: 6,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: (
            await transform(source, {
              format: 'cjs',
              jsxFactory: 'h',
              jsxFragment: 'Fragment',
              loader: 'tsx',
              platform: 'browser',
              target: 'es2020',
            })
          ).code,
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  const document: CompiledCadDocument = {
    apiVersion: 6,
    compilerVersion: CAD_COMPILER_VERSION,
    sourceHash,
    sources: Object.fromEntries(sources),
  }
  const inspection = inspectCompiledDocument(document)
  return executeCompiledDocument(document, generateRandomVars(inspection.varsSchema), bundle.files['simulate.py'])
}

describe('local Experiment templates', () => {
  it('evaluates the Starter through geometry.tsx into a small 3D solid', async () => {
    const result = await evaluate(starterExperimentSourceBundle)

    expect(starterExperimentSourceBundle.files['experiment.tsx']).toContain("from './geometry'")
    expect(result.scene.parts).toHaveLength(1)
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
  })

  it('keeps every required file in Blank and evaluates to an empty Scene', async () => {
    const result = await evaluate(blankExperimentSourceBundle)

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
  })

  it('inherits and remaps the two Wheel Assembly Material roles', async () => {
    const result = await evaluate(wheelAssemblySourceBundle)

    expect(result.scene.parts.map(({ material, materialRole }) => [materialRole, material?.name])).toEqual([
      ['tire', 'Rubber'],
      ['wheel', 'Aluminum'],
    ])
    expect(result.scene.parts.every((part) => part.material?.variables.color === undefined)).toBe(true)
  })
})
