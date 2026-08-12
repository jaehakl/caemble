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
import {
  defineTask,
  experiment,
  ExperimentDefinition,
  TaskDefinition,
  type ExternalVars,
} from '../model/v5'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit, type UcumUnit } from '../model/units'
import type { VarsSchemaEntry } from '../model/vars'
import { EXPERIMENT_ENTRY_PATH, EXPERIMENT_SIMULATION_PATH, experimentTaskName } from '../source/document'
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

function loadCompiledModule(jsCode: string) {
  const exports: Record<string, unknown> = {}
  const module = { exports }
  const runner = new Function(
    'h',
    'Fragment',
    'require',
    'exports',
    'module',
    'Math',
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
    'queueMicrotask',
    'setInterval',
    'setTimeout',
    `"use strict";\n${jsCode}\nreturn module.exports;`,
  )
  const moduleExports = runner(
    h,
    Fragment,
    requireCaembleModule,
    exports,
    module,
    deterministicMath,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  ) as Record<string, unknown>
  return moduleExports.default ?? exports.default
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

function taskDefinitionsFromCompiled(compiled: CompiledCadDocument) {
  const definitions = Object.freeze(
    Object.fromEntries(
      Object.entries(compiled.sources)
        .flatMap(([path, source]) => {
          const taskName = experimentTaskName(path)
          return taskName === null ? [] : [[taskName, loadCompiledTaskCode(source.code)] as const]
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
  if (Object.keys(definitions).length === 0) throw new CadModelError('Experiment requires at least one Task.')
  return definitions
}

function compiledExperimentEntry(compiled: CompiledCadDocument) {
  assertCompiledCadDocument(compiled)
  const entrySource = compiled.sources[EXPERIMENT_ENTRY_PATH]
  if (!entrySource) throw new CadModelError(`Compiled Experiment is missing ${EXPERIMENT_ENTRY_PATH}.`)
  return loadCompiledCode(entrySource.code)
}

export function inspectCompiledDocument(compiled: CompiledCadDocument): CadInspectionResult {
  const entry = compiledExperimentEntry(compiled)
  taskDefinitionsFromCompiled(compiled)
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

export function executeCompiledDocument(
  compiled: CompiledCadDocument,
  vars: ExternalVars,
  pythonSource?: string,
) {
  const entry = compiledExperimentEntry(compiled)
  if (!pythonSource?.trim()) {
    throw new CadModelError(`Compiled Experiment document is missing ${EXPERIMENT_SIMULATION_PATH}.`)
  }
  return evaluateDocumentEntry(entry, compiled.sourceHash, vars, pythonSource, taskDefinitionsFromCompiled(compiled))
}

export const executeCompiledSource = executeCompiledDocument
