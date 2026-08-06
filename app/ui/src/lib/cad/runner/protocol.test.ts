import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import { buildSourceOnlyRealization, type BuiltSample, type BuiltSetup } from '../execution/realization'
import { serializeCadScene } from '../execution/mesh'
import type { EvaluatedExperimentSnapshot, EvaluatedStructureSnapshot } from '../execution/snapshot'
import type { SimulationResult } from '../../simulation/types'
import {
  assertCadEvaluationRequest,
  assertRunnerCancelEvaluationEnvelope,
  assertRunnerCancelSimulationEnvelope,
  assertRunnerEvaluationEnvelope,
  assertRunnerEvaluationResultEnvelope,
  assertRunnerEvaluationStartedEnvelope,
  assertRunnerSimulationEnvelope,
  assertRunnerSimulationProgressEnvelope,
  assertRunnerSimulationResultEnvelope,
  assertRunnerSimulationStartedEnvelope,
  type SimulationRunRequest,
} from './protocol'

const sourceHash = 'b'.repeat(64)
const experimentSourceHash = 'c'.repeat(64)
const nonce = '12345678-1234-1234-1234-123456789abc'
const scene = serializeCadScene({
  geometryGroups: [],
  lengthUnit: 'mm',
  parts: [],
  surfaceGroups: [],
  tree: { children: [], key: 'structure', label: 'Structure' },
})
const experimentScene = serializeCadScene({
  geometryGroups: [],
  lengthUnit: 'mm',
  parts: [],
  surfaceGroups: [],
  tree: { children: [], key: 'experiment', label: 'Experiment' },
})
const compiledStructure: CompiledCadSource = {
  apiVersion: 3,
  compilerVersion: CAD_COMPILER_VERSION,
  entryFile: 'structure.tsx',
  code: 'module.exports.default = {}',
  sourceHash,
}
const compiledExperiment: CompiledCadSource = {
  apiVersion: 3,
  compilerVersion: CAD_COMPILER_VERSION,
  entryFile: 'experiment.tsx',
  code: 'module.exports.default = {}',
  sourceHash: experimentSourceHash,
}
const program = {
  formatVersion: 1 as const,
  programHash: experimentSourceHash,
  tasks: {
    electric: {
      kernel: { name: 'dc-current-density', version: '0.0.0' },
      configHash: 'dc-config',
    },
  },
  recordedData: {
    measuredCurrent: {
      dtype: 'float64' as const,
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent' as const,
    },
  },
}
const structureSnapshot: EvaluatedStructureSnapshot = {
  kind: 'structure',
  scene,
  seed: 7,
  sourceHash,
  variables: {},
  varsSchema: {},
}
const experimentSnapshot: EvaluatedExperimentSnapshot = {
  kind: 'experiment',
  scene: experimentScene,
  seed: 9,
  sourceHash: experimentSourceHash,
  variables: {},
  varsSchema: {},
  simulationProgram: program,
}
const sample = buildSourceOnlyRealization(structureSnapshot) as BuiltSample
const setup = buildSourceOnlyRealization(experimentSnapshot) as BuiltSetup
const evaluationRequest = {
  type: 'evaluate' as const,
  requestId: 'request-1',
  revision: 3,
  document: { kind: 'structure' as const, realizationSeed: 7 },
  compiledSource: compiledStructure,
  vars: { width: 2 },
}
const simulationRequest: SimulationRunRequest = {
  type: 'run-simulation',
  requestId: 'simulation-1',
  structureRevision: 4,
  experimentRevision: 5,
  compiledSource: compiledExperiment,
  sample,
  setup,
}
const simulationResult: SimulationResult = {
  format: 'caemble-run',
  formatVersion: 1,
  runId: simulationRequest.requestId,
  finalStateRevision: 0,
  recordedData: {
    measuredCurrent: {
      spec: program.recordedData.measuredCurrent,
      data: { value: 14.9 },
    },
  },
  trace: [],
  provenance: {
    programHash: program.programHash,
    structureSourceHash: sourceHash,
    experimentSourceHash,
    structureSeed: 7,
    experimentSeed: 9,
    structureVars: {},
    experimentVars: {},
    kernels: [{ name: 'dc-current-density', version: '0.0.0' }],
  },
}

describe('isolated runner protocol', () => {
  it('accepts the exact evaluate, start, result, and cancel messages', () => {
    expect(() => assertCadEvaluationRequest(evaluationRequest)).not.toThrow()
    expect(() =>
      assertRunnerEvaluationEnvelope({
        type: 'evaluate',
        nonce,
        request: evaluationRequest,
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerEvaluationStartedEnvelope({
        type: 'evaluation-started',
        nonce,
        requestId: evaluationRequest.requestId,
        revision: evaluationRequest.revision,
        documentType: 'structure',
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerEvaluationResultEnvelope({
        type: 'evaluation-result',
        nonce,
        response: {
          type: 'evaluation-success',
          documentType: 'structure',
          requestId: evaluationRequest.requestId,
          revision: evaluationRequest.revision,
          snapshot: structureSnapshot,
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerCancelEvaluationEnvelope({
        type: 'cancel-evaluation',
        nonce,
        requestId: evaluationRequest.requestId,
      }),
    ).not.toThrow()
  })

  it('rejects extra fields, wrong source kinds, and forged snapshot kinds', () => {
    expect(() => assertCadEvaluationRequest({ ...evaluationRequest, elevated: true })).toThrow(
      'request.elevated is not allowed',
    )
    expect(() =>
      assertCadEvaluationRequest({
        ...evaluationRequest,
        compiledSource: compiledExperiment,
      }),
    ).toThrow('does not match the requested document kind')
    expect(() =>
      assertRunnerEvaluationResultEnvelope({
        type: 'evaluation-result',
        nonce,
        response: {
          type: 'evaluation-success',
          documentType: 'experiment',
          requestId: evaluationRequest.requestId,
          revision: evaluationRequest.revision,
          snapshot: structureSnapshot,
        },
      }),
    ).toThrow('snapshot kind does not match')
  })

  it('accepts preflight, run, progress, result, and cancellation messages', () => {
    expect(() =>
      assertRunnerSimulationEnvelope({
        type: 'preflight-simulation',
        nonce,
        request: { ...simulationRequest, type: 'preflight-simulation' },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerSimulationEnvelope({
        type: 'run-simulation',
        nonce,
        request: simulationRequest,
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerSimulationStartedEnvelope({
        type: 'simulation-started',
        nonce,
        requestId: simulationRequest.requestId,
        structureRevision: 4,
        experimentRevision: 5,
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerSimulationProgressEnvelope({
        type: 'simulation-progress',
        nonce,
        requestId: simulationRequest.requestId,
        structureRevision: 4,
        experimentRevision: 5,
        progress: {
          runId: simulationRequest.requestId,
          task: 'electric',
          kernel: { name: 'dc-current-density', version: '0.0.0' },
          stage: 'pcg',
          completed: 12,
          total: 100,
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerSimulationResultEnvelope({
        type: 'preflight-simulation-result',
        nonce,
        response: {
          type: 'preflight-simulation-result',
          requestId: simulationRequest.requestId,
          structureRevision: 4,
          experimentRevision: 5,
          issues: [],
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerSimulationResultEnvelope({
        type: 'run-simulation-result',
        nonce,
        response: {
          type: 'run-simulation-success',
          requestId: simulationRequest.requestId,
          structureRevision: 4,
          experimentRevision: 5,
          result: simulationResult,
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerCancelSimulationEnvelope({
        type: 'cancel-simulation',
        nonce,
        requestId: simulationRequest.requestId,
      }),
    ).not.toThrow()
  })

  it('rejects mismatched simulation envelopes, source provenance, and malformed results', () => {
    expect(() =>
      assertRunnerSimulationEnvelope({
        type: 'preflight-simulation',
        nonce,
        request: simulationRequest,
      }),
    ).toThrow('envelope and request types do not match')
    expect(() =>
      assertRunnerSimulationEnvelope({
        type: 'run-simulation',
        nonce,
        request: {
          ...simulationRequest,
          compiledSource: { ...compiledExperiment, sourceHash: 'd'.repeat(64) },
        },
      }),
    ).toThrow('source does not match')
    expect(() =>
      assertRunnerSimulationResultEnvelope({
        type: 'run-simulation-result',
        nonce,
        response: {
          type: 'run-simulation-success',
          requestId: simulationRequest.requestId,
          structureRevision: 4,
          experimentRevision: 5,
          result: { ...simulationResult, recordedData: { measuredCurrent: { data: { value: Number.NaN } } } },
        },
      }),
    ).toThrow()
    expect(() =>
      assertRunnerSimulationResultEnvelope({
        type: 'run-simulation-result',
        nonce,
        response: {
          type: 'run-simulation-success',
          requestId: simulationRequest.requestId,
          structureRevision: 4,
          experimentRevision: 5,
          result: { ...simulationResult, runId: 'different-run' },
        },
      }),
    ).toThrow('runId does not match')
  })
})
