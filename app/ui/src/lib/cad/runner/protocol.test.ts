import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import { serializeCadScene } from '../execution/mesh'
import type { EvaluatedStructureSnapshot } from '../execution/snapshot'
import {
  assertCadEvaluationRequest,
  assertRunnerCancelEvaluationEnvelope,
  assertRunnerEvaluationEnvelope,
  assertRunnerEvaluationResultEnvelope,
  assertRunnerEvaluationStartedEnvelope,
} from './protocol'

const sourceHash = 'b'.repeat(64)
const nonce = '12345678-1234-1234-1234-123456789abc'
const scene = serializeCadScene({
  geometryGroups: [],
  lengthUnit: 'mm',
  parts: [],
  surfaceGroups: [],
  tree: { children: [], key: 'structure', label: 'Structure' },
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
  sourceHash: 'c'.repeat(64),
}
const structureSnapshot: EvaluatedStructureSnapshot = {
  kind: 'structure',
  scene,
  seed: 7,
  sourceHash,
  variables: {},
  varsSchema: {},
}
const evaluationRequest = {
  type: 'evaluate' as const,
  requestId: 'request-1',
  revision: 3,
  document: { kind: 'structure' as const, realizationSeed: 7 },
  compiledSource: compiledStructure,
  vars: { width: 2 },
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

  it('rejects simulation messages as evaluation envelopes', () => {
    expect(() =>
      assertRunnerEvaluationEnvelope({
        type: 'run-simulation',
        nonce,
        request: {
          type: 'run-simulation',
          requestId: 'simulation-1',
        },
      }),
    ).toThrow('Runner evaluation type is invalid')
  })
})
