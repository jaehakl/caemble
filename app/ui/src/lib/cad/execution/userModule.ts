import {
  assertCompiledCadDocument,
  assertCompiledCadSource,
  type CompiledCadDocument,
  type CompiledCadSource,
} from '../compiler/types'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import type { CadScene } from '../evaluation/types'
import { CadModelError, evaluateWithVars, isFloatDType, Mat, Material } from '../model/core'
import { defineTask, experiment, ExperimentDefinition, TaskDefinition, type ExternalVars } from '../model/v5'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit, type UcumUnit } from '../model/units'
import type { VarsSchemaEntry } from '../model/vars'
import { EXPERIMENT_ENTRY_PATH, EXPERIMENT_SIMULATION_PATH, experimentTaskName } from '../source/document'
import type { GeometryCoordinate } from '../source/geometrySnapshot'
import type { EvaluatedRuntimeDocumentSnapshot } from './snapshot'

const coreModule = Object.freeze({
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
  TaskDefinition,
})

const deterministicMath = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((name) => name !== 'random')
      .map((name) => [name, (Math as unknown as Record<string, unknown>)[name]]),
  ),
)

export type CadExecutionResult = EvaluatedRuntimeDocumentSnapshot
export type CadDocumentEntry = ExperimentDefinition
export type CadInspectionResult = Readonly<{
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
}>

export function requireCaembleModule(specifier: string) {
  if (specifier === '@caemble/core') return coreModule
  throw new CadModelError(`Unsupported Caemble runtime import: ${specifier}`)
}

function executeCompiledModule(
  jsCode: string,
  requireModule: (specifier: string) => unknown,
  rootBindings: Readonly<Record<string, unknown>> = {},
) {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const entries = Object.entries(rootBindings)
  const createRunner = new Function(
    ...entries.map(([name]) => name),
    `return function(
      h,
      Fragment,
      require,
      exports,
      module,
      Math,
      Date,
      crypto,
      performance,
      globalThis,
      window,
      self,
      fetch,
      Function,
      XMLHttpRequest,
      WebSocket,
      queueMicrotask,
      setInterval,
      setTimeout,
      clearInterval,
      clearTimeout,
      Worker,
      SharedWorker,
      process,
      global
    ) { "use strict";\n${jsCode}\nreturn module.exports; }`,
  )
  const runner = createRunner(...entries.map(([, value]) => value)) as (...parameters: unknown[]) => unknown
  const moduleExports = runner(
    h,
    Fragment,
    requireModule,
    exports,
    module,
    deterministicMath,
    ...Array<undefined>(19).fill(undefined),
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

type CompiledGeometryRuntime = Readonly<{
  roots: Readonly<Record<string, unknown>>
  load: (coordinate: GeometryCoordinate) => unknown
}>

function compiledGeometryRuntime(compiled: CompiledCadDocument): CompiledGeometryRuntime {
  const graph = compiled.geometryGraph
  if (!graph) {
    return Object.freeze({
      roots: Object.freeze({}),
      load: (coordinate: GeometryCoordinate) => {
        throw new CadModelError(`Compiled Geometry dependency is unavailable: ${coordinate}`)
      },
    })
  }
  const cache = new Map<GeometryCoordinate, { state: 'loading' | 'loaded'; value?: unknown }>()
  const load = (coordinate: GeometryCoordinate): unknown => {
    const cached = cache.get(coordinate)
    if (cached?.state === 'loading')
      throw new CadModelError(`Geometry module dependency cycle detected at ${coordinate}.`)
    if (cached?.state === 'loaded') return cached.value
    const module = graph.modules[coordinate]
    if (!module) throw new CadModelError(`Geometry module dependency is unresolved: ${coordinate}`)
    cache.set(coordinate, { state: 'loading' })
    try {
      const allowed = new Set(module.imports)
      const exports = executeCompiledModule(module.code, (specifier) => {
        if (specifier === '@caemble/core') return coreModule
        if (!allowed.has(specifier as GeometryCoordinate)) {
          throw new CadModelError(`Geometry module ${coordinate} attempted an undeclared import: ${specifier}`)
        }
        return Object.freeze({ __esModule: true, default: load(specifier as GeometryCoordinate) })
      })
      const value = exports.default
      if (typeof value !== 'function') {
        throw new CadModelError(`Geometry module ${coordinate} must export one function component.`)
      }
      cache.set(coordinate, { state: 'loaded', value })
      return value
    } catch (error) {
      cache.delete(coordinate)
      throw error
    }
  }
  const roots = Object.freeze(Object.fromEntries(graph.roots.map((root) => [root.alias, load(root.coordinate)])))
  return Object.freeze({ roots, load })
}

function taskDefinitionsFromCompiled(compiled: CompiledCadDocument, geometryRuntime: CompiledGeometryRuntime) {
  const definitions = Object.freeze(
    Object.fromEntries(
      Object.entries(compiled.sources)
        .flatMap(([path, source]) => {
          const taskName = experimentTaskName(path)
          if (taskName === null) return []
          const task = executeCompiledModule(source.code, requireCaembleModule, geometryRuntime.roots).default
          if (!(task instanceof TaskDefinition)) {
            throw new CadModelError(`Task Source ${path} must export default defineTask({...}) from @caemble/core.`)
          }
          return [[taskName, task] as const]
        })
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  )
  if (Object.keys(definitions).length === 0) throw new CadModelError('Experiment requires at least one Task.')
  return definitions
}

function compiledExperimentEntry(compiled: CompiledCadDocument, geometryRuntime: CompiledGeometryRuntime) {
  assertCompiledCadDocument(compiled)
  const entrySource = compiled.sources[EXPERIMENT_ENTRY_PATH]
  if (!entrySource) throw new CadModelError(`Compiled Experiment is missing ${EXPERIMENT_ENTRY_PATH}.`)
  const entry = executeCompiledModule(entrySource.code, requireCaembleModule, geometryRuntime.roots).default
  if (!(entry instanceof ExperimentDefinition)) {
    throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
  }
  return entry
}

export function inspectCompiledDocument(compiled: CompiledCadDocument): CadInspectionResult {
  assertCompiledCadDocument(compiled)
  const geometryRuntime = compiledGeometryRuntime(compiled)
  const entry = compiledExperimentEntry(compiled, geometryRuntime)
  taskDefinitionsFromCompiled(compiled, geometryRuntime)
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
  const geometryRuntime = compiledGeometryRuntime(compiled)
  const entry = compiledExperimentEntry(compiled, geometryRuntime)
  if (!pythonSource?.trim()) {
    throw new CadModelError(`Compiled Experiment document is missing ${EXPERIMENT_SIMULATION_PATH}.`)
  }
  return evaluateDocumentEntry(
    entry,
    compiled.sourceHash,
    vars,
    pythonSource,
    taskDefinitionsFromCompiled(compiled, geometryRuntime),
  )
}

export function evaluateCompiledGeometryModule(
  compiled: CompiledCadDocument,
  coordinate: GeometryCoordinate,
  lengthUnit: UcumUnit = 'mm',
) {
  assertCompiledCadDocument(compiled)
  const runtime = compiledGeometryRuntime(compiled)
  return evaluateCadScene(
    h(runtime.load(coordinate) as (props: Record<string, unknown>) => unknown, { id: 'preview' }),
    {},
    `Geometry ${coordinate}`,
    lengthUnit,
  )
}

export const executeCompiledSource = executeCompiledDocument
