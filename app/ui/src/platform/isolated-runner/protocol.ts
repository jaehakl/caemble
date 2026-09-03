import type { CadWorkerRequest, CadWorkerResponse } from '@/lib/cad/worker/protocol'

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

export function resolveRunnerReadyHostOrigin(search: string, allowedHostOrigins: ReadonlySet<string>) {
  const candidate = new URLSearchParams(search).get('hostOrigin')
  if (!candidate) return undefined
  try {
    const origin = new URL(candidate).origin
    return candidate === origin && allowedHostOrigins.has(origin) ? origin : undefined
  } catch {
    return undefined
  }
}

function secureEnvelope(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Runner message is invalid.')
  return value as Record<string, unknown>
}

function secureNonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/u.test(value)) {
    throw new Error('Runner message nonce is invalid.')
  }
}

export function assertCadWorkerRequest(value: unknown): asserts value is CadWorkerRequest {
  const request = secureEnvelope(value)
  if (request.type !== 'inspect' && request.type !== 'evaluate' && request.type !== 'preview-geometry') {
    throw new Error('Runner operation is invalid.')
  }
}

export function assertCadInspectionRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'inspect' }> {
  assertCadWorkerRequest(value)
}
export function assertCadEvaluationRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'evaluate' }> {
  assertCadWorkerRequest(value)
}
export function assertCadGeometryPreviewRequest(
  value: unknown,
): asserts value is Extract<CadWorkerRequest, { type: 'preview-geometry' }> {
  assertCadWorkerRequest(value)
}

export function assertRunnerOperationEnvelope(value: unknown): asserts value is RunnerOperationEnvelope {
  const envelope = secureEnvelope(value)
  secureNonce(envelope.nonce)
  assertCadWorkerRequest(envelope.request)
  if (envelope.type !== envelope.request.type) throw new Error('Runner operation is invalid.')
}

export function assertRunnerOperationStartedEnvelope(value: unknown): asserts value is RunnerOperationStartedEnvelope {
  const envelope = secureEnvelope(value)
  secureNonce(envelope.nonce)
  if (envelope.type !== 'operation-started') throw new Error('Runner operation start is invalid.')
}

export function assertRunnerOperationResultEnvelope(value: unknown): asserts value is RunnerOperationResultEnvelope {
  const envelope = secureEnvelope(value)
  secureNonce(envelope.nonce)
  if (envelope.type !== 'operation-result') throw new Error('Runner operation result is invalid.')
}

export function assertRunnerCancelOperationEnvelope(value: unknown): asserts value is RunnerCancelOperationEnvelope {
  const envelope = secureEnvelope(value)
  secureNonce(envelope.nonce)
  if (envelope.type !== 'cancel-operation') throw new Error('Runner cancellation is invalid.')
}

export function runnerOperationRejectionEnvelope(
  value: unknown,
  error: unknown,
): RunnerOperationResultEnvelope | undefined {
  try {
    const envelope = secureEnvelope(value)
    secureNonce(envelope.nonce)
    const request = secureEnvelope(envelope.request)
    if (envelope.type !== 'inspect' && envelope.type !== 'evaluate' && envelope.type !== 'preview-geometry')
      return undefined
    return {
      type: 'operation-result',
      operation: envelope.type,
      nonce: envelope.nonce,
      response: {
        type:
          envelope.type === 'inspect'
            ? 'inspection-error'
            : envelope.type === 'evaluate'
              ? 'evaluation-error'
              : 'geometry-preview-error',
        requestId: String(request.requestId),
        revision: Number(request.revision),
        documentType: envelope.type === 'preview-geometry' ? 'geometry' : 'experiment',
        errorType: 'model',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  } catch {
    return undefined
  }
}
