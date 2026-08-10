import { assertCompiledCadDocument } from '../compiler/types'
import { assertEvaluatedDocumentSnapshot } from '../execution/snapshotValidation'
import { CadModelError } from '../model/errors'
import type { CadEvaluationRequest, CadEvaluationResponse } from '../worker/protocol'

export type RunnerEvaluationEnvelope = Readonly<{
  type: 'evaluate'
  nonce: string
  request: CadEvaluationRequest
}>

export type RunnerEvaluationStartedEnvelope = Readonly<{
  type: 'evaluation-started'
  nonce: string
  requestId: string
  revision: number
  documentType: 'structure' | 'experiment'
}>

export type RunnerEvaluationResultEnvelope = Readonly<{
  type: 'evaluation-result'
  nonce: string
  response: CadEvaluationResponse
}>

export type RunnerCancelEvaluationEnvelope = Readonly<{
  type: 'cancel-evaluation'
  nonce: string
  requestId: string
}>

function assertPlainObject(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new CadModelError(`${path} must be a plain object.`)
  }
}

function assertOnlyKeys(value: object, allowed: readonly string[], path: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new CadModelError(`${path}.${unknown} is not allowed.`)
}

function assertNonce(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(value)) {
    throw new CadModelError('Runner message nonce is invalid.')
  }
}

function assertIdentity(requestId: unknown, revision: unknown, path: string) {
  if (
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    requestId.length > 256 ||
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0
  ) {
    throw new CadModelError(`${path} identity is invalid.`)
  }
}

function assertEvaluationVars(vars: unknown) {
  if (vars === undefined) return
  assertPlainObject(vars, 'request.vars')
  if (Object.keys(vars).length > 4096) {
    throw new CadModelError('CAD evaluation vars exceed the key-count limit.')
  }
}

export function assertCadEvaluationRequest(value: unknown): asserts value is CadEvaluationRequest {
  assertPlainObject(value, 'request')
  assertOnlyKeys(value, ['type', 'requestId', 'revision', 'document', 'compiledDocument', 'vars'], 'request')
  if (value.type !== 'evaluate') throw new CadModelError('CAD evaluation request type is invalid.')
  assertIdentity(value.requestId, value.revision, 'CAD evaluation request')
  assertPlainObject(value.document, 'request.document')
  assertOnlyKeys(value.document, ['kind', 'realizationSeed', 'pythonSource'], 'request.document')
  if (
    (value.document.kind !== 'structure' && value.document.kind !== 'experiment') ||
    !Number.isSafeInteger(value.document.realizationSeed) ||
    (value.document.realizationSeed as number) < 0
  ) {
    throw new CadModelError('CAD evaluation request document is invalid.')
  }
  if (value.document.kind === 'experiment') {
    if (typeof value.document.pythonSource !== 'string' || !value.document.pythonSource.trim()) {
      throw new CadModelError('Experiment evaluation requires Python simulation source.')
    }
  } else if (value.document.pythonSource !== undefined) {
    throw new CadModelError('Structure evaluation cannot contain Python simulation code.')
  }
  assertCompiledCadDocument(value.compiledDocument)
  if (!value.compiledDocument.sources[`${value.document.kind}.tsx`]) {
    throw new CadModelError('Compiled CAD document does not match the requested document kind.')
  }
  assertEvaluationVars(value.vars)
}

export function assertRunnerEvaluationEnvelope(value: unknown): asserts value is RunnerEvaluationEnvelope {
  assertPlainObject(value, 'evaluation')
  assertOnlyKeys(value, ['type', 'nonce', 'request'], 'evaluation')
  if (value.type !== 'evaluate') throw new CadModelError('Runner evaluation type is invalid.')
  assertNonce(value.nonce)
  assertCadEvaluationRequest(value.request)
}

export function assertRunnerEvaluationStartedEnvelope(
  value: unknown,
): asserts value is RunnerEvaluationStartedEnvelope {
  assertPlainObject(value, 'evaluationStarted')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId', 'revision', 'documentType'], 'evaluationStarted')
  if (
    value.type !== 'evaluation-started' ||
    (value.documentType !== 'structure' && value.documentType !== 'experiment')
  ) {
    throw new CadModelError('Runner evaluation started envelope is invalid.')
  }
  assertNonce(value.nonce)
  assertIdentity(value.requestId, value.revision, 'Runner evaluation started')
}

export function assertRunnerEvaluationResultEnvelope(value: unknown): asserts value is RunnerEvaluationResultEnvelope {
  assertPlainObject(value, 'evaluationResult')
  assertOnlyKeys(value, ['type', 'nonce', 'response'], 'evaluationResult')
  if (value.type !== 'evaluation-result') throw new CadModelError('Runner evaluation result type is invalid.')
  assertNonce(value.nonce)
  assertPlainObject(value.response, 'evaluationResult.response')
  const response = value.response
  assertIdentity(response.requestId, response.revision, 'Runner evaluation result')
  if (response.documentType !== 'structure' && response.documentType !== 'experiment') {
    throw new CadModelError('Runner evaluation result document type is invalid.')
  }
  if (response.type === 'evaluation-success') {
    assertOnlyKeys(response, ['type', 'requestId', 'revision', 'documentType', 'snapshot'], 'evaluationResult.response')
    assertEvaluatedDocumentSnapshot(response.snapshot)
    if (response.snapshot.kind !== response.documentType) {
      throw new CadModelError('Runner evaluation snapshot kind does not match the response.')
    }
    return
  }
  if (
    response.type !== 'evaluation-error' ||
    !['compile', 'type', 'policy', 'runtime', 'model'].includes(String(response.errorType)) ||
    typeof response.message !== 'string' ||
    response.message.length > 65_536 ||
    (response.stack !== undefined && typeof response.stack !== 'string') ||
    (response.diagnostics !== undefined && !Array.isArray(response.diagnostics))
  ) {
    throw new CadModelError('Runner evaluation error response is invalid.')
  }
  assertOnlyKeys(
    response,
    ['type', 'requestId', 'revision', 'documentType', 'errorType', 'message', 'diagnostics', 'stack'],
    'evaluationResult.response',
  )
}

export function assertRunnerCancelEvaluationEnvelope(value: unknown): asserts value is RunnerCancelEvaluationEnvelope {
  assertPlainObject(value, 'cancelEvaluation')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId'], 'cancelEvaluation')
  if (value.type !== 'cancel-evaluation' || typeof value.requestId !== 'string' || !value.requestId) {
    throw new CadModelError('Runner evaluation cancellation is invalid.')
  }
  assertNonce(value.nonce)
}
