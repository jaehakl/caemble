import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
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
const compiledStructure: CompiledCadDocument = {
  apiVersion: 4,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'structure.tsx': {
      apiVersion: 4,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'structure.tsx',
      code: 'module.exports.default = {}',
      sourceHash,
    },
  },
}
const experimentHash = 'c'.repeat(64)
const compiledExperiment: CompiledCadDocument = {
  apiVersion: 4,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash: experimentHash,
  sources: {
    'experiment.tsx': {
      apiVersion: 4,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'experiment.tsx',
      code: 'module.exports.default = {}',
      sourceHash: experimentHash,
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
const evaluationRequest = {
  type: 'evaluate' as const,
  requestId: 'request-1',
  revision: 3,
  document: { kind: 'structure' as const, realizationSeed: 7 },
  compiledDocument: compiledStructure,
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
        compiledDocument: compiledExperiment,
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
