import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { defaultCode } from '../../defaultCode'
import { defaultExperimentSourceBundle } from '../../defaultExperimentCode'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '../compiler/types'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './snapshot'
import { executeCompiledCode, executeCompiledDocument, requireCaembleModule } from './userModule'

async function compile(source: string) {
  return (
    await transform(source, {
      format: 'cjs',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      loader: 'tsx',
      platform: 'browser',
      target: 'es2020',
    })
  ).code
}

async function compiledDocument(
  files: Readonly<Record<string, string>>,
  sourceHash: string,
): Promise<CompiledCadDocument> {
  const entries = await Promise.all(
    Object.entries(files)
      .filter(([path]) => path.endsWith('.tsx'))
      .map(async ([entryFile, source]) => {
        const compiled: CompiledCadSource = {
          apiVersion: 4,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compile(source),
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  return { apiVersion: 4, compilerVersion: CAD_COMPILER_VERSION, sourceHash, sources: Object.fromEntries(entries) }
}

describe('compiled CAD source execution', () => {
  it('exposes only the unversioned public authoring module', () => {
    expect(requireCaembleModule('@caemble/core')).toMatchObject({
      defineTask: expect.any(Function),
      experiment: expect.any(Function),
      Mat: expect.any(Function),
      Material: expect.any(Function),
      structure: expect.any(Function),
    })
    expect(() => requireCaembleModule('./local-module')).toThrow('Unsupported Caemble runtime import')
  })

  it('evaluates a Structure with externally supplied vars', async () => {
    const result = executeCompiledCode(await compile(defaultCode), 'structure', '1'.repeat(64), 101, {
      conductorSize: [100, 12, 10],
      electricalConductivity: 5.96e7,
      notchPosition: [-10, 4, 2.5],
      notchSize: [20, 4, 5],
    })
    if (result.kind !== 'structure') throw new Error('Expected Structure')
    const part = result.scene.parts[0]
    expect(result.scene.geometryGroups[0]).toMatchObject({ name: 'conductor', geometryIds: ['conductor'] })
    expect(part.material).toMatchObject({
      name: 'Copper',
      variables: {
        'electrical.conductivity': {
          quantityKind: 'electromagnetism.ElectricConductivity',
          basis: identityCartesianBasis,
        },
      },
    })
    expect(geometries.geom3.isA(part.geometry)).toBe(true)
    expect(measurements.measureVolume(part.geometry)).toBeGreaterThan(0)
  })

  it('evaluates common vars and independent Task scenes into manifest v4', async () => {
    const sourceHash = '2'.repeat(64)
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, sourceHash)
    const pythonSource = defaultExperimentSourceBundle.files['simulate.py']
    const result = executeCompiledDocument(compiled, 'experiment', 17, {}, pythonSource)
    if (result.kind !== 'experiment') throw new Error('Expected Experiment')
    const snapshot = serializeEvaluatedDocumentSnapshot(result)

    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    expect(result.simulationProgram).toMatchObject({
      formatVersion: 4,
      simulationApiVersion: 2,
      pythonSource,
      tasks: {
        electric: { kernel: { name: 'dc-current-density', version: '0.0.0' }, config: expect.any(Object) },
      },
    })
    expect(result.taskScenes.electric.parts.map((part) => part.id)).toEqual(['experiment-device'])
  })

  it('requires Python source and the correct entry kind', async () => {
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, '3'.repeat(64))
    expect(() => executeCompiledDocument(compiled, 'experiment', 5)).toThrow('missing simulate.py')
    expect(() => executeCompiledDocument(compiled, 'structure', 5)).toThrow('missing structure.tsx')
  })
})
