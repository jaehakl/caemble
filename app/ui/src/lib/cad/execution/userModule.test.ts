import { geometries, measurements } from '@jscad/modeling'
import { transform } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSyntheticCatalog } from '@/test/syntheticCatalog'
import { starterExperimentSourceBundle } from '../../localExperimentCode'
import { CAD_COMPILER_VERSION, type CompiledCadDocument, type CompiledCadSource } from '../compiler/types'
import { generateRandomVars } from '../model/vars'
import {
  evaluateCompiledGeometryModule,
  executeCompiledDocument,
  inspectCompiledDocument,
  requireCaembleModule,
} from './userModule'

installSyntheticCatalog({
  quantityKinds: [
    { name: 'DimensionlessRatio', applicableUnits: ['{fraction}'] },
    { name: 'electromagnetism.ElectricCurrent', applicableUnits: ['A'] },
    { name: 'electromagnetism.Voltage', applicableUnits: ['mV'] },
    { name: 'electromagnetism.ElectricConductivity', tensorOrder: 2, applicableUnits: ['S.m-1'] },
  ],
  materialParameters: [{ key: 'electrical.conductivity', quantityKind: 'electromagnetism.ElectricConductivity' }],
})

afterEach(() => vi.unstubAllGlobals())

async function compile(source: string, sourcefile: string) {
  return (
    await transform(source, {
      format: 'cjs',
      jsxFactory: 'h',
      jsxFragment: 'Fragment',
      loader: sourcefile.endsWith('.tsx') ? 'tsx' : 'ts',
      platform: 'browser',
      sourcefile,
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
      .filter(([path]) => path.endsWith('.ts') || path.endsWith('.tsx'))
      .map(async ([entryFile, source]) => {
        const compiled: CompiledCadSource = {
          apiVersion: 9,
          compilerVersion: CAD_COMPILER_VERSION,
          entryFile,
          code: await compile(source, entryFile),
          sourceHash,
        }
        return [entryFile, compiled] as const
      }),
  )
  return { apiVersion: 9, compilerVersion: CAD_COMPILER_VERSION, sourceHash, sources: Object.fromEntries(entries) }
}

describe('compiled Experiment bundle execution', () => {
  it('evaluates the Starter Experiment through the bundle module loader', async () => {
    expect(requireCaembleModule('@caemble/core')).toMatchObject({
      Box: 'box',
      Cylinder: 'cylinder',
      experiment: expect.any(Function),
      radians: expect.any(Function),
    })
    const compiled = await compiledDocument(starterExperimentSourceBundle.files, '2'.repeat(64))
    const inspection = inspectCompiledDocument(compiled)
    const result = executeCompiledDocument(
      compiled,
      generateRandomVars(inspection.varsSchema),
      starterExperimentSourceBundle.files['simulate.py'],
    )
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(measurements.measureVolume(result.scene.parts[0].geometry)).toBeGreaterThan(0)
  })

  it('shadows eval plus Worker network, storage, and messaging capabilities exposed by the host', async () => {
    const shadowedNames = [
      'WebSocketStream',
      'WebTransport',
      'EventSource',
      'RTCPeerConnection',
      'RTCDataChannel',
      'BroadcastChannel',
      'importScripts',
      'caches',
      'indexedDB',
      'cookieStore',
      'location',
      'navigator',
      'postMessage',
      'close',
      'MessageChannel',
      'MessagePort',
      'MessageEvent',
      'addEventListener',
      'removeEventListener',
      'dispatchEvent',
      'onmessage',
      'onmessageerror',
    ] as const
    const checks = shadowedNames
      .map((name) => `if (typeof ${name} !== 'undefined') throw new Error('${name} leaked')`)
      .join('\n')
    const compiled = await compiledDocument(
      {
        'experiment.tsx': `import { experiment } from '@caemble/core'
${checks}
if (typeof eval !== 'undefined') throw new Error('eval leaked')
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })`,
        'geometry.tsx': 'export {}',
        'material.tsx': 'export {}',
      },
      'f'.repeat(64),
    )
    shadowedNames.forEach((name) => vi.stubGlobal(name, Object.freeze({ exposed: name })))

    expect(() => inspectCompiledDocument(compiled)).not.toThrow()
  })

  it('loads helpers once and shares one cache across preview, Experiment, Geometry, and Tasks', async () => {
    const files = {
      'shared/leaf.tsx': `export const token = {}
export const Part = () => <box size={[1, 1, 1]} />`,
      'shared/root.tsx': `import { Part, token as first } from './leaf'
import { token as second } from './leaf'
if (first !== second) throw new Error('module executed twice')
export const Shared = Part`,
      'geometry.tsx': `export { Shared } from './shared/root'`,
      'material.tsx': 'export {}',
      'experiment.tsx': `import { experiment } from '@caemble/core'
import { Shared } from './geometry'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <Shared id="shared" />, recordedData: {} })`,
      'tasks/electric.tsx': `import { defineTask } from '@caemble/core'
import { Shared } from '../shared/root'
export default defineTask({ kernel: { name: 'test', version: '1' }, geometry: () => <Shared id="task" />, config: () => ({}) })`,
    }
    const compiled = await compiledDocument(files, '3'.repeat(64))
    const result = executeCompiledDocument(compiled, {}, 'async def simulate(*, sim, tasks, vars):\n    return None\n')
    expect(result.scene.parts[0].id).toBe('shared.box')
    expect(result.taskScenes.electric.parts[0].id).toBe('task.box')
    expect(evaluateCompiledGeometryModule(compiled, 'shared/root.tsx', 'Shared').parts[0].id).toBe('preview.box')
  })

  it('rejects non-component preview exports at the runtime boundary', async () => {
    const compiled = await compiledDocument(
      {
        'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null, recordedData: {} })`,
        'geometry.tsx': 'export {}',
        'material.tsx': 'export {}',
        'shared/static.ts': 'export const Static = 1',
      },
      '9'.repeat(64),
    )
    expect(() => evaluateCompiledGeometryModule(compiled, 'shared/static.ts', 'Static')).toThrow('function component')
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
    }
    const valid = await compiledDocument(files, 'c'.repeat(64))
    expect(() => inspectCompiledDocument(valid)).not.toThrow()
    const invalidValue = await compiledDocument(
      { ...files, 'material.tsx': 'export const Invalid = 1' },
      'd'.repeat(64),
    )
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

  it('supports an Experiment with no Task files for local inspection and evaluation', async () => {
    const files = {
      'experiment.tsx': `import { experiment } from '@caemble/core'
export default experiment({ lengthUnit: 'mm', varsSchema: {}, geometry: () => <box size={[2, 3, 4]} />, recordedData: {} })`,
      'geometry.tsx': 'export {}',
      'material.tsx': 'export {}',
    }
    const compiled = await compiledDocument(files, '8'.repeat(64))
    expect(inspectCompiledDocument(compiled).varsSchema).toEqual({})
    const result = executeCompiledDocument(compiled, {}, 'async def simulate(*, sim, tasks, vars):\n    return None\n')
    expect(result.scene.parts).toHaveLength(1)
    expect(geometries.geom3.isA(result.scene.parts[0].geometry)).toBe(true)
    expect(result.taskScenes).toEqual({})
    expect(result.simulationProgram.tasks).toEqual({})
  })
})
