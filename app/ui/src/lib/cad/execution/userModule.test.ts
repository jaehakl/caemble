import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { defaultExperimentSourceBundle } from '../../defaultExperimentCode'
import {
  CAD_COMPILER_VERSION,
  type CompiledCadDocument,
  type CompiledCadSource,
  type CompiledGeometryModule,
} from '../compiler/types'
import { generateRandomVars } from '../model/vars'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import type { GeometryModuleCoordinate } from '../source/effectiveGeometryGraph'
import {
  evaluateCompiledGeometryModule,
  executeCompiledDocument,
  inspectCompiledDocument,
  requireCaembleModule,
} from './userModule'

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
          apiVersion: 6,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compile(source),
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  return { apiVersion: 6, compilerVersion: CAD_COMPILER_VERSION, sourceHash, sources: Object.fromEntries(entries) }
}

function module(
  entryFile: GeometryModuleCoordinate,
  code: string,
  exports: readonly string[],
  imports: CompiledGeometryModule['imports'] = [],
  sourceHash = '4'.repeat(64),
): CompiledGeometryModule {
  return {
    apiVersion: 6,
    compilerVersion: CAD_COMPILER_VERSION,
    entryFile,
    code,
    sourceHash,
    geometrySourceHash: '5'.repeat(64),
    moduleHash: '6'.repeat(64),
    exports,
    imports,
  }
}

describe('compiled Experiment execution with source Geometry modules', () => {
  it('evaluates the default Experiment and Task through geometry.tsx', async () => {
    expect(requireCaembleModule('@caemble/core')).toHaveProperty('experiment')
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, '2'.repeat(64))
    const inspection = inspectCompiledDocument(compiled)
    const result = executeCompiledDocument(
      compiled,
      generateRandomVars(inspection.varsSchema),
      defaultExperimentSourceBundle.files['simulate.py'],
    )
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
    expect(result.taskScenes.electric.parts).toHaveLength(1)
  })

  it('loads named exports once, resolves relative geometry.tsx imports, and isolates module scopes', async () => {
    const leafCoordinate = 'caemble:geometry/jlee/demo/leaf@1.0.0' as GeometryCoordinate
    const rootCoordinate = 'caemble:geometry/jlee/demo/root@1.0.0' as GeometryCoordinate
    const files = {
      'geometry.tsx': `import { Shared } from "${rootCoordinate}"\nexport { Shared }`,
      'material.tsx': 'export {}',
      'experiment.tsx': `import { experiment } from '@caemble/core'\nimport { Shared } from './geometry'\nexport default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Shared id="shared" />, recordedData: {} })`,
      'tasks/electric.tsx': `import { defineTask } from '@caemble/core'\nimport { Shared } from '../geometry'\nexport default defineTask({ kernel: { name: 'test', version: '1' }, geometry: () => <Shared id="task" />, config: () => ({}) })`,
    }
    const compiled = await compiledDocument(files, '3'.repeat(64))
    const leaf = module(
      leafCoordinate,
      `exports.Part = ({ id }) => h('box', { id, size: [1, 1, 1] })`,
      ['Part'],
      [],
      compiled.sourceHash,
    )
    const root = module(
      rootCoordinate,
      `const first = require(${JSON.stringify(leafCoordinate)}); const second = require(${JSON.stringify(leafCoordinate)}); if (first !== second) throw new Error('module executed twice'); exports.Shared = first.Part`,
      ['Shared'],
      [{ exportName: 'Part', alias: 'Part', coordinate: leafCoordinate }],
      compiled.sourceHash,
    )
    const graph: CompiledCadDocument = {
      ...compiled,
      geometryGraph: {
        graphHash: '7'.repeat(64),
        entryImports: [
          { exportName: 'Shared', alias: 'Shared', coordinate: rootCoordinate, moduleHash: root.moduleHash },
        ],
        modules: { [leafCoordinate]: leaf, [rootCoordinate]: root },
      },
    }
    const result = executeCompiledDocument(graph, {}, 'async def simulate(*, sim, tasks, vars):\n    return None\n')
    expect(result.scene.parts[0].id).toBe('shared')
    expect(result.taskScenes.electric.parts[0].id).toBe('task')
    expect(evaluateCompiledGeometryModule(graph, rootCoordinate, 'Shared').parts[0].id).toBe('preview')
    expect((globalThis as Record<string, unknown>).__geometryLeak).toBeUndefined()
  })

  it('rejects static named exports at the runtime boundary', async () => {
    const coordinate = 'caemble:geometry/jlee/demo/static@1.0.0' as GeometryCoordinate
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, '9'.repeat(64))
    const legacy = module(
      coordinate,
      `exports.Static = h('box', { size: [1, 1, 1] })`,
      ['Static'],
      [],
      compiled.sourceHash,
    )
    expect(() =>
      evaluateCompiledGeometryModule(
        {
          ...compiled,
          geometryGraph: {
            graphHash: 'a'.repeat(64),
            entryImports: [{ exportName: 'Static', alias: 'Static', coordinate, moduleHash: legacy.moduleHash }],
            modules: { [coordinate]: legacy },
          },
        },
        coordinate,
        'Static',
      ),
    ).toThrow('function component')
  })

  it('loads named Material values and validates Material factory results', async () => {
    const files = {
      'geometry.tsx': 'export {}',
      'material.tsx': `import { Material } from '@caemble/core'
export const Direct = new Material('Direct')
export const Factory = (name: string) => new Material(name)`,
      'experiment.tsx': `import { experiment } from '@caemble/core'
import { Direct, Factory } from './material'
void Direct
void Factory('Factory')
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })`,
      'tasks/main.tsx': `import { defineTask } from '@caemble/core'
import { Direct } from '../material'
void Direct
export default defineTask({ kernel: { name: 'test', version: '1' }, config: () => ({}) })`,
    }
    const valid = await compiledDocument(files, 'c'.repeat(64))
    expect(() => inspectCompiledDocument(valid)).not.toThrow()

    const invalidValue = await compiledDocument({ ...files, 'material.tsx': 'export const Invalid = 1' }, 'd'.repeat(64))
    expect(() => inspectCompiledDocument(invalidValue)).toThrow('Material instance or factory')

    const invalidFactory = await compiledDocument(
      {
        ...files,
        'material.tsx': 'export const Invalid = () => 1',
        'experiment.tsx': `import { experiment } from '@caemble/core'
import { Invalid } from './material'
void Invalid()
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })`,
      },
      'e'.repeat(64),
    )
    expect(() => inspectCompiledDocument(invalidFactory)).toThrow('must return a Material instance')
  })

  it('treats an @local module like a virtual published module during preview', async () => {
    const coordinate = 'caemble:geometry/jlee/demo/working@local' as GeometryModuleCoordinate
    const compiled = await compiledDocument(defaultExperimentSourceBundle.files, '8'.repeat(64))
    const working = module(
      coordinate,
      `exports.Working = ({ id, size = [2, 3, 4] }) => h('box', { id, size })`,
      ['Working'],
      [],
      compiled.sourceHash,
    )

    expect(
      evaluateCompiledGeometryModule(
        {
          ...compiled,
          geometryGraph: {
            graphHash: 'b'.repeat(64),
            entryImports: [{ exportName: 'Working', alias: 'Working', coordinate, moduleHash: working.moduleHash }],
            modules: { [coordinate]: working },
          },
        },
        coordinate,
        'Working',
      ).parts[0].id,
    ).toBe('preview')
  })
})
