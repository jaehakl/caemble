import { assertCompiledCadDocument } from '../compiler/types'
import { assertEvaluatedDocumentSnapshot } from '../execution/snapshotValidation'
import { CadModelError } from '../model/errors'
import { normalizeVarsSchema } from '../model/vars'
import { assertSerializableCadScene } from '../execution/meshValidation'
import type { CadWorkerRequest, CadWorkerResponse } from '../worker/protocol'

export type RunnerOperationEnvelope = Readonly<{
  type: 'inspect' | 'evaluate' | 'preview-geometry'
  nonce: string
  request: CadWorkerRequest
}>

export type RunnerOperationStartedEnvelope = Readonly<{
  type: 'operation-started'
  operation: 'inspect' | 'evaluate' | 'preview-geometry'
  nonce: string
  requestId: string
  revision: number
  documentType: 'experiment' | 'geometry'
}>

export type RunnerOperationResultEnvelope = Readonly<{
  type: 'operation-result'
  operation: 'inspect' | 'evaluate' | 'preview-geometry'
  nonce: string
  response: CadWorkerResponse
}>

export type RunnerCancelOperationEnvelope = Readonly<{
  type: 'cancel-operation'
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
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/u.test(value)) {
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

function assertVars(vars: unknown) {
  assertPlainObject(vars, 'request.vars')
  if (Object.keys(vars).length > 4096) throw new CadModelError('CAD evaluation vars exceed the key-count limit.')
}

export function assertCadWorkerRequest(value: unknown): asserts value is CadWorkerRequest {
  assertPlainObject(value, 'request')
  assertIdentity(value.requestId, value.revision, 'CAD runner request')
  assertCompiledCadDocument(value.compiledDocument)
  if (!value.compiledDocument.sources['experiment.tsx']) {
    throw new CadModelError('Compiled CAD document must contain experiment.tsx.')
  }
  if (value.type === 'inspect') {
    assertOnlyKeys(value, ['type', 'requestId', 'revision', 'compiledDocument'], 'request')
    return
  }
  if (value.type === 'preview-geometry') {
    assertOnlyKeys(
      value,
      ['type', 'requestId', 'revision', 'compiledDocument', 'coordinate', 'exportName', 'lengthUnit'],
      'request',
    )
    const module =
      typeof value.coordinate === 'string'
        ? Object.entries(value.compiledDocument.geometryGraph?.modules ?? {}).find(
            ([coordinate]) => coordinate === value.coordinate,
          )?.[1]
        : undefined
    if (
      !value.compiledDocument.geometryGraph ||
      typeof value.coordinate !== 'string' ||
      !module ||
      typeof value.exportName !== 'string' ||
      !module.exports.includes(value.exportName) ||
      typeof value.lengthUnit !== 'string' ||
      !value.lengthUnit
    ) {
      throw new CadModelError('Geometry preview request is invalid.')
    }
    return
  }
  if (value.type !== 'evaluate') throw new CadModelError('CAD runner request type is invalid.')
  assertOnlyKeys(value, ['type', 'requestId', 'revision', 'compiledDocument', 'pythonSource', 'vars'], 'request')
  if (typeof value.pythonSource !== 'string' || !value.pythonSource.trim()) {
    throw new CadModelError('Experiment evaluation requires Python simulation source.')
  }
  assertVars(value.vars)
}

export function assertCadInspectionRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'inspect' }> {
  assertCadWorkerRequest(value)
  if (value.type !== 'inspect') throw new CadModelError('CAD inspection request type is invalid.')
}

export function assertCadEvaluationRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'evaluate' }> {
  assertCadWorkerRequest(value)
  if (value.type !== 'evaluate') throw new CadModelError('CAD evaluation request type is invalid.')
}

export function assertCadGeometryPreviewRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'preview-geometry' }> {
  assertCadWorkerRequest(value)
  if (value.type !== 'preview-geometry') throw new CadModelError('CAD Geometry preview request type is invalid.')
}

export function assertRunnerOperationEnvelope(value: unknown): asserts value is RunnerOperationEnvelope {
  assertPlainObject(value, 'operation')
  assertOnlyKeys(value, ['type', 'nonce', 'request'], 'operation')
  if (value.type !== 'inspect' && value.type !== 'evaluate' && value.type !== 'preview-geometry') {
    throw new CadModelError('Runner operation type is invalid.')
  }
  assertNonce(value.nonce)
  assertCadWorkerRequest(value.request)
  if (value.type !== value.request.type) throw new CadModelError('Runner operation does not match its request.')
}

export function assertRunnerOperationStartedEnvelope(value: unknown): asserts value is RunnerOperationStartedEnvelope {
  assertPlainObject(value, 'operationStarted')
  assertOnlyKeys(value, ['type', 'operation', 'nonce', 'requestId', 'revision', 'documentType'], 'operationStarted')
  if (
    value.type !== 'operation-started' ||
    (value.operation !== 'inspect' && value.operation !== 'evaluate' && value.operation !== 'preview-geometry') ||
    (value.documentType !== 'experiment' && value.documentType !== 'geometry')
  ) {
    throw new CadModelError('Runner operation started envelope is invalid.')
  }
  assertNonce(value.nonce)
  assertIdentity(value.requestId, value.revision, 'Runner operation started')
  const expectedDocumentType = value.operation === 'preview-geometry' ? 'geometry' : 'experiment'
  if (value.documentType !== expectedDocumentType) {
    throw new CadModelError('Runner operation started document type does not match its operation.')
  }
}

function assertErrorResponse(
  response: Record<string, unknown>,
  errorType: 'inspection-error' | 'evaluation-error' | 'geometry-preview-error',
) {
  if (
    response.type !== errorType ||
    !['compile', 'type', 'policy', 'runtime', 'model'].includes(String(response.errorType)) ||
    typeof response.message !== 'string' ||
    response.message.length > 65_536 ||
    (response.stack !== undefined && typeof response.stack !== 'string') ||
    (response.diagnostics !== undefined && !Array.isArray(response.diagnostics))
  ) {
    throw new CadModelError('Runner operation error response is invalid.')
  }
  assertOnlyKeys(
    response,
    ['type', 'requestId', 'revision', 'documentType', 'errorType', 'message', 'diagnostics', 'stack'],
    'operationResult.response',
  )
}

export function assertRunnerOperationResultEnvelope(value: unknown): asserts value is RunnerOperationResultEnvelope {
  assertPlainObject(value, 'operationResult')
  assertOnlyKeys(value, ['type', 'operation', 'nonce', 'response'], 'operationResult')
  if (
    value.type !== 'operation-result' ||
    (value.operation !== 'inspect' && value.operation !== 'evaluate' && value.operation !== 'preview-geometry')
  ) {
    throw new CadModelError('Runner operation result type is invalid.')
  }
  assertNonce(value.nonce)
  assertPlainObject(value.response, 'operationResult.response')
  const response = value.response
  assertIdentity(response.requestId, response.revision, 'Runner operation result')
  if (response.documentType !== 'experiment' && response.documentType !== 'geometry') {
    throw new CadModelError('Runner result document type is invalid.')
  }
  if (value.operation === 'inspect') {
    if (response.documentType !== 'experiment') throw new CadModelError('Runner inspection document type is invalid.')
    if (response.type === 'inspection-success') {
      assertOnlyKeys(
        response,
        ['type', 'requestId', 'revision', 'documentType', 'sourceHash', 'varsSchema'],
        'operationResult.response',
      )
      if (typeof response.sourceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(response.sourceHash)) {
        throw new CadModelError('Runner inspection source provenance is invalid.')
      }
      normalizeVarsSchema(response.varsSchema, 'Runner inspection')
      return
    }
    assertErrorResponse(response, 'inspection-error')
    return
  }
  if (value.operation === 'preview-geometry') {
    if (response.documentType !== 'geometry')
      throw new CadModelError('Runner Geometry preview document type is invalid.')
    if (response.type === 'geometry-preview-success') {
      assertOnlyKeys(
        response,
        ['type', 'requestId', 'revision', 'documentType', 'sourceHash', 'scene'],
        'operationResult.response',
      )
      if (typeof response.sourceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(response.sourceHash)) {
        throw new CadModelError('Runner Geometry preview source provenance is invalid.')
      }
      assertSerializableCadScene(response.scene)
      return
    }
    assertErrorResponse(response, 'geometry-preview-error')
    return
  }
  if (response.documentType !== 'experiment') throw new CadModelError('Runner evaluation document type is invalid.')
  if (response.type === 'evaluation-success') {
    assertOnlyKeys(response, ['type', 'requestId', 'revision', 'documentType', 'snapshot'], 'operationResult.response')
    assertEvaluatedDocumentSnapshot(response.snapshot)
    return
  }
  assertErrorResponse(response, 'evaluation-error')
}

export function assertRunnerCancelOperationEnvelope(value: unknown): asserts value is RunnerCancelOperationEnvelope {
  assertPlainObject(value, 'cancelOperation')
  assertOnlyKeys(value, ['type', 'nonce', 'requestId'], 'cancelOperation')
  if (value.type !== 'cancel-operation' || typeof value.requestId !== 'string' || !value.requestId) {
    throw new CadModelError('Runner operation cancellation is invalid.')
  }
  assertNonce(value.nonce)
}
