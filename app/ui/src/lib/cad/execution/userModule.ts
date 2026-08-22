import {
  assertCompiledCadDocument,
  assertCompiledCadSource,
  type CompiledCadDocument,
  type CompiledCadSource,
} from '../compiler/types'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import type { CadScene } from '../evaluation/types'
import { cadPrimitiveAuthoringBindings } from '../elements/generated'
import { CadModelError, evaluateWithVars, isFloatDType, Mat, Material, radians } from '../model/core'
import { defineTask, experiment, ExperimentDefinition, TaskDefinition, type ExternalVars } from '../model/v5'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit, type UcumUnit } from '../model/units'
import type { VarsSchemaEntry } from '../model/vars'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  EXPERIMENT_SIMULATION_PATH,
  experimentTaskName,
} from '../source/document'
import { resolveExperimentModuleSpecifier } from '../source/moduleResolution'
import type { EvaluatedRuntimeDocumentSnapshot } from './snapshot'

const coreModule = Object.freeze({
  ...cadPrimitiveAuthoringBindings,
  assertUcumUnitComparable,
  CadModelError,
  convertUcumValue,
  defineTask,
  experiment,
  ExperimentDefinition,
  isFloatDType,
  Mat,
  Material,
  normalizeUcumUnit,
  radians,
  TaskDefinition,
})

const deterministicMath = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((name) => name !== 'random')
      .map((name) => [name, (Math as unknown as Record<string, unknown>)[name]]),
  ),
)

// `eval` is shadowed by the non-strict factory that encloses the strict authored-code function.
const shadowedRuntimeGlobalNames = Object.freeze([
  'Date',
  'crypto',
  'performance',
  'globalThis',
  'window',
  'self',
  'fetch',
  'Function',
  'XMLHttpRequest',
  'WebSocket',
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
  'queueMicrotask',
  'setInterval',
  'setTimeout',
  'clearInterval',
  'clearTimeout',
  'Worker',
  'SharedWorker',
  'process',
  'global',
])

export type CadExecutionResult = EvaluatedRuntimeDocumentSnapshot
export type CadDocumentEntry = ExperimentDefinition
export type CadInspectionResult = Readonly<{
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
}>

export function requireCaembleModule(specifier: string) {
  if (specifier === '@caemble/core') return coreModule
  throw new CadModelError(`Unsupported Caemble runtime import: ${specifier}`)
}

function executeCompiledModule(jsCode: string, requireModule: (specifier: string) => unknown) {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const createRunner = new Function(
    'eval',
    `return function(
      h,
      Fragment,
      require,
      exports,
      module,
      Math,
      ${shadowedRuntimeGlobalNames.join(',\n      ')}
  ) { "use strict";\n${jsCode}\nreturn module.exports; }`,
  )
  const runner = createRunner(undefined) as (...parameters: unknown[]) => unknown
  const moduleExports = runner(
    h,
    Fragment,
    requireModule,
    exports,
    module,
    deterministicMath,
    ...Array<undefined>(shadowedRuntimeGlobalNames.length).fill(undefined),
  ) as Record<string, unknown>
  return moduleExports
}

function loadCompiledModule(jsCode: string, requireModule: (specifier: string) => unknown = requireCaembleModule) {
  const moduleExports = executeCompiledModule(jsCode, requireModule)
  return moduleExports.default
}

export function loadCompiledCode(jsCode: string): ExperimentDefinition {
  const entry = loadCompiledModule(jsCode)
  if (!(entry instanceof ExperimentDefinition)) {
    throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
  }
  return entry
}

export function loadCompiledTaskCode(jsCode: string) {
  const entry = loadCompiledModule(jsCode)
  if (!(entry instanceof TaskDefinition)) {
    throw new CadModelError('Task Source must export default defineTask({...}) from @caemble/core.')
  }
  return entry
}

export function loadCompiledSource(compiledSource: CompiledCadSource) {
  assertCompiledCadSource(compiledSource)
  if (compiledSource.entryFile !== EXPERIMENT_ENTRY_PATH) {
    throw new CadModelError(`Compiled Experiment source entry must be ${EXPERIMENT_ENTRY_PATH}.`)
  }
  return loadCompiledCode(compiledSource.code)
}

type CompiledMaterialRuntime = Readonly<Record<string, Material | ((...parameters: unknown[]) => Material)>>

type CompiledModuleLoader = Readonly<{
  load: (path: string) => Readonly<Record<string, unknown>>
  replace: (path: string, exports: Readonly<Record<string, unknown>>) => void
}>

function compiledModuleLoader(compiled: CompiledCadDocument): CompiledModuleLoader {
  assertCompiledCadDocument(compiled)
  const cache = new Map<string, { state: 'loading' | 'loaded'; value?: Readonly<Record<string, unknown>> }>()
  const load = (path: string): Readonly<Record<string, unknown>> => {
    const cached = cache.get(path)
    if (cached?.state === 'loading') throw new CadModelError(`Experiment module dependency cycle detected at ${path}.`)
    if (cached?.state === 'loaded') return cached.value!
    const source = compiled.sources[path]
    if (!source) throw new CadModelError(`Compiled Experiment module is unresolved: ${path}`)
    cache.set(path, { state: 'loading' })
    try {
      const exports = executeCompiledModule(source.code, (specifier) =>
        specifier === '@caemble/core'
          ? coreModule
          : load(resolveExperimentModuleSpecifier(compiled.sources, path, specifier)),
      )
      if (typeof exports !== 'object' || exports === null || Array.isArray(exports)) {
        throw new CadModelError(`Compiled Experiment module must expose named or default exports: ${path}`)
      }
      const value = Object.freeze({ ...exports })
      cache.set(path, { state: 'loaded', value })
      return value
    } catch (error) {
      cache.delete(path)
      throw error
    }
  }
  return Object.freeze({
    load,
    replace(path, exports) {
      cache.set(path, { state: 'loaded', value: exports })
    },
  })
}

function compiledMaterialRuntime(loader: CompiledModuleLoader): CompiledMaterialRuntime {
  const exports = loader.load(EXPERIMENT_MATERIAL_PATH)
  if (Object.prototype.hasOwnProperty.call(exports, 'default')) {
    throw new CadModelError('material.tsx only supports named Material object or factory exports.')
  }
  const runtime = Object.freeze(
    Object.fromEntries(
      Object.entries(exports).map(([name, value]) => {
        if (value instanceof Material) return [name, value]
        if (typeof value !== 'function' || value === Material) {
          throw new CadModelError(`Material export ${name} must be a Material instance or factory.`)
        }
        const factory = (...parameters: unknown[]) => {
          const material = value(...parameters)
          if (!(material instanceof Material)) {
            throw new CadModelError(`Material factory ${name} must return a Material instance.`)
          }
          return material
        }
        return [name, factory]
      }),
    ),
  )
  loader.replace(EXPERIMENT_MATERIAL_PATH, runtime)
  return runtime
}

function taskDefinitionsFromCompiled(compiled: CompiledCadDocument, loader: CompiledModuleLoader) {
  const definitions = Object.freeze(
    Object.fromEntries(
      Object.keys(compiled.sources)
        .flatMap((path) => {
          const taskName = experimentTaskName(path)
          if (taskName === null) return []
          const task = loader.load(path).default
          if (!(task instanceof TaskDefinition)) {
            throw new CadModelError(`Task Source ${path} must export default defineTask({...}) from @caemble/core.`)
          }
          return [[taskName, task] as const]
        })
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  )
  return definitions
}

function compiledExperimentEntry(loader: CompiledModuleLoader) {
  const entry = loader.load(EXPERIMENT_ENTRY_PATH).default
  if (!(entry instanceof ExperimentDefinition)) {
    throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
  }
  return entry
}

export function inspectCompiledDocument(compiled: CompiledCadDocument): CadInspectionResult {
  assertCompiledCadDocument(compiled)
  const loader = compiledModuleLoader(compiled)
  compiledMaterialRuntime(loader)
  const entry = compiledExperimentEntry(loader)
  taskDefinitionsFromCompiled(compiled, loader)
  return Object.freeze({ varsSchema: entry.varsSchema })
}

function emptyTaskScene(label: string, lengthUnit: UcumUnit): CadScene {
  return {
    lengthUnit,
    parts: [],
    tree: { key: label.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), label, children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
}

export function evaluateDocumentEntry(
  entry: ExperimentDefinition,
  sourceHash: string,
  vars: ExternalVars,
  pythonSource: string,
  taskDefinitions: Readonly<Record<string, TaskDefinition>>,
): CadExecutionResult {
  if (typeof pythonSource !== 'string' || !pythonSource.trim()) {
    throw new CadModelError('Experiment evaluation requires non-empty Python simulation source.')
  }
  const variables = entry.resolveExternal(vars)
  return evaluateWithVars(variables, () => {
    const runtime = entry.createProgramRuntime(variables, pythonSource, taskDefinitions)
    const scene = evaluateCadScene(
      entry.evaluateResolvedGeometry(variables),
      { geometryGroup: entry.geometryGroup, surfaceGroup: entry.surfaceGroup },
      'Experiment',
      entry.lengthUnit,
    )
    const taskScenes = Object.freeze(
      Object.fromEntries(
        Object.entries(taskDefinitions).map(([name, task]) => {
          const label = `Task ${JSON.stringify(name)}`
          const lengthUnit = task.lengthUnit ?? entry.lengthUnit
          const root = task.evaluateResolvedGeometry(variables)
          return [
            name,
            root === undefined
              ? emptyTaskScene(label, lengthUnit)
              : evaluateCadScene(
                  root,
                  { geometryGroup: task.geometryGroup, surfaceGroup: task.surfaceGroup },
                  label,
                  lengthUnit,
                ),
          ]
        }),
      ),
    )
    return Object.freeze({
      kind: 'experiment' as const,
      sourceHash,
      variables,
      varsSchema: entry.varsSchema,
      scene,
      taskScenes,
      simulationProgram: runtime.manifest,
    })
  })
}

export function executeCompiledCode(
  jsCode: string,
  sourceHash: string,
  vars: ExternalVars,
  pythonSource: string,
  taskDefinitions: Readonly<Record<string, TaskDefinition>>,
) {
  return evaluateDocumentEntry(loadCompiledCode(jsCode), sourceHash, vars, pythonSource, taskDefinitions)
}

export function executeCompiledDocument(compiled: CompiledCadDocument, vars: ExternalVars, pythonSource?: string) {
  assertCompiledCadDocument(compiled)
  const loader = compiledModuleLoader(compiled)
  compiledMaterialRuntime(loader)
  const entry = compiledExperimentEntry(loader)
  if (!pythonSource?.trim()) {
    throw new CadModelError(`Compiled Experiment document is missing ${EXPERIMENT_SIMULATION_PATH}.`)
  }
  return evaluateDocumentEntry(
    entry,
    compiled.sourceHash,
    vars,
    pythonSource,
    taskDefinitionsFromCompiled(compiled, loader),
  )
}

export function evaluateCompiledGeometryModule(
  compiled: CompiledCadDocument,
  path: string,
  exportName: string,
  lengthUnit: UcumUnit = 'mm',
) {
  assertCompiledCadDocument(compiled)
  const loader = compiledModuleLoader(compiled)
  compiledMaterialRuntime(loader)
  const exports = loader.load(path)
  const component = exports[exportName]
  if (!Object.prototype.hasOwnProperty.call(exports, exportName) || typeof component !== 'function') {
    throw new CadModelError(`Geometry export ${exportName} in ${path} must be a function component.`)
  }
  return evaluateCadScene(
    h(component as (props: Record<string, unknown>) => unknown, { id: 'preview' }),
    {},
    `Geometry ${path}`,
    lengthUnit,
  )
}

export const executeCompiledSource = executeCompiledDocument
