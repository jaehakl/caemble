import {
  assertCompiledCadDocument,
  assertCompiledCadSource,
  type CompiledCadDocument,
  type CompiledCadSource,
} from '../compiler/types'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import { CadModelError, evaluateWithVars, isFloatDType, Mat, Material, Structure } from '../model/core'
import {
  defineTask,
  experiment,
  ExperimentDefinition,
  structure,
  StructureDefinition,
  TaskDefinition,
  type CadDefinition,
  type ExternalVars,
} from '../model/v4'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit } from '../model/units'
import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_SIMULATION_PATH,
  experimentTaskName,
  type CadDocumentType,
} from '../source/document'
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
  structure,
  Structure,
  StructureDefinition,
  TaskDefinition,
})

export type CadExecutionResult = EvaluatedRuntimeDocumentSnapshot
export type CadDocumentEntry = CadDefinition

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
    `"use strict";\n${jsCode}\nreturn module.exports;`,
  )
  const moduleExports = runner(h, Fragment, requireCaembleModule, exports, module) as Record<string, unknown>
  return moduleExports.default ?? exports.default
}

export function loadCompiledCode(jsCode: string, documentType: CadDocumentType): CadDocumentEntry {
  return assertDocumentEntry(loadCompiledModule(jsCode), documentType)
}

export function loadCompiledTaskCode(jsCode: string) {
  const entry = loadCompiledModule(jsCode)
  if (!(entry instanceof TaskDefinition)) {
    throw new CadModelError('Task Source must export default defineTask({...}) from @caemble/core.')
  }
  return entry
}

function assertDocumentEntry(entry: unknown, documentType: CadDocumentType): CadDocumentEntry {
  if (documentType === 'experiment') {
    if (!(entry instanceof ExperimentDefinition)) {
      throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
    }
    return entry
  }
  if (!(entry instanceof StructureDefinition) || entry instanceof ExperimentDefinition) {
    throw new CadModelError('Structure Source must export default structure({...}) from @caemble/core.')
  }
  return entry
}

export function loadCompiledSource(compiledSource: CompiledCadSource, documentType: CadDocumentType): CadDocumentEntry {
  assertCompiledCadSource(compiledSource)
  const expectedEntry = `${documentType}.tsx`
  if (compiledSource.entryFile !== expectedEntry) {
    throw new CadModelError(`Compiled CAD source entry ${compiledSource.entryFile} does not match ${documentType}.`)
  }
  return loadCompiledCode(compiledSource.code, documentType)
}

function taskDefinitionsFromCompiled(compiled: CompiledCadDocument) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(compiled.sources)
        .flatMap(([path, source]) => {
          const taskName = experimentTaskName(path)
          return taskName === null ? [] : [[taskName, loadCompiledTaskCode(source.code)] as const]
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  )
}

export function evaluateDocumentEntry(
  entry: CadDocumentEntry,
  documentType: CadDocumentType,
  sourceHash: string,
  seed: number,
  partialVars: ExternalVars = {},
  pythonSource?: string,
  taskDefinitions: Readonly<Record<string, TaskDefinition>> = {},
): CadExecutionResult {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new CadModelError('Evaluation seed must be a non-negative safe integer.')
  }

  if (documentType === 'experiment') {
    if (!(entry instanceof ExperimentDefinition)) {
      throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
    }
    if (typeof pythonSource !== 'string' || !pythonSource.trim()) {
      throw new CadModelError('Experiment evaluation requires non-empty Python simulation source.')
    }
    const variables = entry.resolveExternal(partialVars, seed)
    return evaluateWithVars(
      variables,
      () => {
        const runtime = entry.createProgramRuntime(variables, pythonSource, taskDefinitions)
        const taskScenes = Object.freeze(
          Object.fromEntries(
            Object.entries(taskDefinitions).map(([name, task]) => [
              name,
              evaluateCadScene(
                task.evaluateResolvedGeometry(variables),
                { geometryGroup: task.geometryGroup, surfaceGroup: task.surfaceGroup },
                `Task ${JSON.stringify(name)}`,
                task.lengthUnit,
              ),
            ]),
          ),
        )
        return Object.freeze({
          kind: 'experiment' as const,
          sourceHash,
          seed,
          taskScenes,
          variables,
          varsSchema: entry.varsSchema,
          simulationProgram: runtime.manifest,
        })
      },
      seed,
    )
  }

  if (!(entry instanceof StructureDefinition) || entry instanceof ExperimentDefinition) {
    throw new CadModelError('Structure Source must export default structure({...}) from @caemble/core.')
  }
  const variables = entry.resolveExternal(partialVars, seed)
  return evaluateWithVars(
    variables,
    () =>
      Object.freeze({
        kind: 'structure' as const,
        sourceHash,
        seed,
        scene: evaluateCadScene(
          entry.evaluateResolvedGeometry(variables),
          { geometryGroup: entry.geometryGroup, surfaceGroup: entry.surfaceGroup },
          'Structure',
          entry.lengthUnit,
        ),
        variables,
        varsSchema: entry.varsSchema,
      }),
    seed,
  )
}

export function executeCompiledCode(
  jsCode: string,
  documentType: CadDocumentType = 'structure',
  sourceHash = 'test-source',
  seed = 0,
  partialVars: ExternalVars = {},
  pythonSource?: string,
  taskDefinitions: Readonly<Record<string, TaskDefinition>> = {},
) {
  return evaluateDocumentEntry(
    loadCompiledCode(jsCode, documentType),
    documentType,
    sourceHash,
    seed,
    partialVars,
    pythonSource,
    taskDefinitions,
  )
}

export function executeCompiledDocument(
  compiled: CompiledCadDocument,
  documentType: CadDocumentType,
  seed: number,
  partialVars: ExternalVars = {},
  pythonSource?: string,
) {
  assertCompiledCadDocument(compiled)
  const entryPath = documentType === 'structure' ? 'structure.tsx' : EXPERIMENT_ENTRY_PATH
  const entrySource = compiled.sources[entryPath]
  if (!entrySource) throw new CadModelError(`Compiled CAD document is missing ${entryPath}.`)
  if (documentType === 'structure' && Object.keys(compiled.sources).length !== 1) {
    throw new CadModelError('Compiled Structure document cannot contain Task sources.')
  }
  const taskDefinitions = documentType === 'experiment' ? taskDefinitionsFromCompiled(compiled) : {}
  if (documentType === 'experiment' && !pythonSource?.trim()) {
    throw new CadModelError(`Compiled Experiment document is missing ${EXPERIMENT_SIMULATION_PATH}.`)
  }
  return evaluateDocumentEntry(
    loadCompiledCode(entrySource.code, documentType),
    documentType,
    compiled.sourceHash,
    seed,
    partialVars,
    pythonSource,
    taskDefinitions,
  )
}

export function executeCompiledSource(
  compiled: CompiledCadDocument,
  documentType: CadDocumentType,
  seed: number,
  partialVars: ExternalVars = {},
  pythonSource?: string,
) {
  return executeCompiledDocument(compiled, documentType, seed, partialVars, pythonSource)
}
