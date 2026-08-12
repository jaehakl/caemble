import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { defaultExperimentSourceBundle } from '../../defaultExperimentCode'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '../compiler/types'
import { generateRandomVars } from '../model/vars'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './snapshot'
import { executeCompiledDocument, inspectCompiledDocument, requireCaembleModule } from './userModule'

async function compile(source: string) {
  return (await transform(source, { format: 'cjs', jsxFactory: 'h', jsxFragment: 'Fragment', loader: 'tsx', platform: 'browser', target: 'es2020' })).code
}

async function compiledDocument(files: Readonly<Record<string, string>>, sourceHash: string): Promise<CompiledCadDocument> {
  const entries = await Promise.all(
    Object.entries(files).filter(([path]) => path.endsWith('.tsx')).map(async ([entryFile, source]) => {
      const compiled: CompiledCadSource = { apiVersion: 5, compilerVersion: CAD_COMPILER_VERSION, entryFile, code: await compile(source), sourceHash }
      return [entryFile, compiled] as const
    }),
  )
  return { apiVersion: 5, compilerVersion: CAD_COMPILER_VERSION, sourceHash, sources: Object.fromEntries(entries) }
}

describe('compiled Experiment execution v5', () => {
  it('exposes no Structure authoring API', () => {
    const core = requireCaembleModule('@caemble/core') as Record<string, unknown>
    expect(core).toMatchObject({ defineTask: expect.any(Function), experiment: expect.any(Function), Mat: expect.any(Function), Material: expect.any(Function) })
    expect(core).not.toHaveProperty('structure')
    expect(core).not.toHaveProperty('Structure')
  })

  it('inspects schema, requires complete vars, and evaluates common plus Task scenes', async () => {
    const sourceHash = '2'.repeat(64)
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, sourceHash)
    const pythonSource = defaultExperimentSourceBundle.files['simulate.py']
    const inspection = inspectCompiledDocument(compiled)
    const variables = generateRandomVars(inspection.varsSchema)
    const result = executeCompiledDocument(compiled, variables, pythonSource)
    const snapshot = serializeEvaluatedDocumentSnapshot(result)

    expect(() => assertEvaluatedDocumentSnapshot(snapshot)).not.toThrow()
    expect(result.simulationProgram).toMatchObject({ formatVersion: 5, simulationApiVersion: 3, pythonSource })
    expect(result.scene.geometryGroups[0]).toMatchObject({ name: 'conductor', geometryIds: ['conductor'] })
    expect(result.scene.parts[0].material).toMatchObject({
      name: 'Copper', variables: { 'electrical.conductivity': { quantityKind: 'electromagnetism.ElectricConductivity', basis: identityCartesianBasis } },
    })
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
    expect(result.taskScenes.electric.parts.map((part) => part.id)).toEqual(['experiment-device'])
    expect(() => executeCompiledDocument(compiled, {}, pythonSource)).toThrow('vars.conductorSize')
    expect(snapshot).not.toHaveProperty('seed')
  })
})
