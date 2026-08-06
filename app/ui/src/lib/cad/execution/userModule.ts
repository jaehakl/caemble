import { CadModelError, evaluateWithVars, isFloatDType, Mat, Material, Structure } from '../model/core'
import {
  experiment,
  ExperimentDefinition,
  structure,
  StructureDefinition,
  type CadDefinition,
  type ExternalVars,
} from '../model/v3'
import { evaluateCadScene } from '../evaluation/evaluator'
import { Fragment, h } from '../evaluation/jsx'
import type { CadDocumentType } from '../source/document'
import type { EvaluatedRuntimeDocumentSnapshot } from './snapshot'
import { assertCompiledCadSource, type CompiledCadSource } from '../compiler/types'
import { kernelAuthoring } from '../../simulation/kernels'
import { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit } from '../model/units'

const coreModule = Object.freeze({
  assertUcumUnitComparable,
  CadModelError,
  convertUcumValue,
  experiment,
  ExperimentDefinition,
  isFloatDType,
  Mat,
  Material,
  normalizeUcumUnit,
  structure,
  Structure,
  StructureDefinition,
})

const kernelsModule = kernelAuthoring

export type CadExecutionResult = EvaluatedRuntimeDocumentSnapshot
export type CadDocumentEntry = CadDefinition

export function requireCaembleModule(specifier: string) {
  if (specifier === '@caemble/core') return coreModule
  if (specifier === '@caemble/kernels') return kernelsModule
  throw new CadModelError(`Unsupported Caemble runtime import: ${specifier}`)
}

export function loadCompiledCode(jsCode: string, documentType: CadDocumentType): CadDocumentEntry {
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
  return assertDocumentEntry(moduleExports.default ?? exports.default, documentType)
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

export function evaluateDocumentEntry(
  entry: CadDocumentEntry,
  documentType: CadDocumentType,
  sourceHash: string,
  seed: number,
  partialVars: ExternalVars = {},
  simulationCode?: string,
  simulationCodeHash?: string,
): CadExecutionResult {
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new CadModelError('Evaluation seed must be a non-negative safe integer.')
  }

  if (documentType === 'experiment') {
    if (!(entry instanceof ExperimentDefinition)) {
      throw new CadModelError('Experiment Source must export default experiment({...}) from @caemble/core.')
    }
    if (
      typeof simulationCode !== 'string' ||
      !simulationCode.trim() ||
      typeof simulationCodeHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(simulationCodeHash)
    ) {
      throw new CadModelError('Experiment evaluation requires non-empty Python simulation source and its SHA-256 hash.')
    }
    const variables = entry.resolveExternal(partialVars, seed)
    return evaluateWithVars(
      variables,
      () => {
        const runtime = entry.createProgramRuntime(variables, sourceHash, simulationCode, simulationCodeHash)
        return Object.freeze({
          kind: 'experiment' as const,
          sourceHash,
          seed,
          scene: evaluateCadScene(
            entry.evaluateResolvedGeometry(variables),
            {
              geometryGroup: entry.geometryGroup,
              surfaceGroup: entry.surfaceGroup,
            },
            'Experiment',
            entry.lengthUnit,
          ),
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
          {
            geometryGroup: entry.geometryGroup,
            surfaceGroup: entry.surfaceGroup,
          },
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
  simulationCode?: string,
  simulationCodeHash?: string,
) {
  return evaluateDocumentEntry(
    loadCompiledCode(jsCode, documentType),
    documentType,
    sourceHash,
    seed,
    partialVars,
    simulationCode,
    simulationCodeHash,
  )
}

export function executeCompiledSource(
  compiledSource: CompiledCadSource,
  documentType: CadDocumentType,
  seed: number,
  partialVars: ExternalVars = {},
  simulationCode?: string,
  simulationCodeHash?: string,
) {
  return evaluateDocumentEntry(
    loadCompiledSource(compiledSource, documentType),
    documentType,
    compiledSource.sourceHash,
    seed,
    partialVars,
    simulationCode,
    simulationCodeHash,
  )
}
