import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { defaultExperimentSourceBundle } from '../../defaultExperimentCode'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '../compiler/types'
import { generateRandomVars } from '../model/vars'
import { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './snapshot'
import {
  evaluateCompiledGeometryModule,
  executeCompiledDocument,
  inspectCompiledDocument,
  requireCaembleModule,
} from './userModule'
import type { CompiledGeometryModule } from '../compiler/types'
import type { GeometryCoordinate } from '../source/geometrySnapshot'

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
          apiVersion: 5,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compile(source),
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  return { apiVersion: 5, compilerVersion: CAD_COMPILER_VERSION, sourceHash, sources: Object.fromEntries(entries) }
}

describe('compiled Experiment execution v5', () => {
  it('exposes no Structure authoring API', () => {
    const core = requireCaembleModule('@caemble/core') as Record<string, unknown>
    expect(core).toMatchObject({
      defineTask: expect.any(Function),
      experiment: expect.any(Function),
      Mat: expect.any(Function),
      Material: expect.any(Function),
    })
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
      name: 'Copper',
      variables: {
        'electrical.conductivity': {
          quantityKind: 'electromagnetism.ElectricConductivity',
          basis: identityCartesianBasis,
        },
      },
    })
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
    expect(result.taskScenes.electric.parts.map((part) => part.id)).toEqual(['experiment-device'])
    expect(() => executeCompiledDocument(compiled, {}, pythonSource)).toThrow('vars.conductorSize')
    expect(snapshot).not.toHaveProperty('seed')
  })

  it('shares Geometry modules across Experiment and Task registry imports with CommonJS default interop', async () => {
    const sourceHash = '3'.repeat(64)
    const leafCoordinate = 'caemble:geometry/jlee/demo/leaf@1.0.0' as GeometryCoordinate
    const proxyCoordinate = 'caemble:geometry/jlee/demo/proxy@1.0.0' as GeometryCoordinate
    const coordinate = 'caemble:geometry/jlee/demo/shared@1.0.0' as GeometryCoordinate
    const files = {
      'experiment.tsx': `import { experiment } from '@caemble/core'
import geometries from '@caemble/geometries'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => geometries.shared, recordedData: {} })`,
      'tasks/electric.tsx': `import { defineTask } from '@caemble/core'
import geometries from '@caemble/geometries'
export default defineTask({ kernel: { name: 'test', version: '1' }, lengthUnit: 'mm', geometry: () => geometries.shared, config: () => ({}) })`,
    }
    const compiled = await compiledDocument(files, sourceHash)
    const geometryModule = (
      entryFile: GeometryCoordinate,
      code: string,
      moduleHash: string,
      imports: readonly GeometryCoordinate[],
    ): CompiledGeometryModule => ({
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile,
      code,
      sourceHash,
      geometrySourceHash: '4'.repeat(64),
      moduleHash,
      imports,
    })
    const leaf = geometryModule(
      leafCoordinate,
      `module.exports.default = h('box', { size: [1, 1, 1] })`,
      '5'.repeat(64),
      [],
    )
    const proxy = geometryModule(
      proxyCoordinate,
      `module.exports.default = require(${JSON.stringify(leafCoordinate)}).default`,
      '6'.repeat(64),
      [leafCoordinate],
    )
    const geometry = geometryModule(
      coordinate,
      `const leaf = require(${JSON.stringify(leafCoordinate)}).default
const proxy = require(${JSON.stringify(proxyCoordinate)}).default
if (leaf !== proxy) throw new Error('shared dependency evaluated twice')
module.exports.default = leaf`,
      '7'.repeat(64),
      [leafCoordinate, proxyCoordinate],
    )
    const graph: CompiledCadDocument = {
      ...compiled,
      geometryGraph: {
        graphHash: '8'.repeat(64),
        roots: [{ alias: 'shared', coordinate, moduleHash: geometry.moduleHash }],
        modules: {
          [coordinate]: geometry,
          [leafCoordinate]: leaf,
          [proxyCoordinate]: proxy,
        },
      },
    }
    const result = executeCompiledDocument(graph, {}, 'async def simulate(*, sim, tasks, vars):\n    return None\n')

    expect(result.scene.parts[0].id).toBe('shared')
    expect(result.taskScenes.electric.parts[0].id).toBe('shared')
    expect(evaluateCompiledGeometryModule(graph, leafCoordinate).parts[0].id).toBe('preview')
  })
})
