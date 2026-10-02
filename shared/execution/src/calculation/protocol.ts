import {
  CALCULATION_LOG_MAX_ENTRIES,
  CALCULATION_LOG_MAX_ENTRY_BYTES,
  calculationExecutionErrorCodes,
  type CalculationExecutionErrorCode,
  type CalculationInput,
  type CalculationSourceDiagnostic,
  type NormalizedCalculationOutput,
  type CompiledCalculationSource,
} from './types'

const encoder = new TextEncoder()

export type CalculationRunRequest = Readonly<{
  type: 'calculate'
  requestId: string
  revision: number
  compiledSource: CompiledCalculationSource
  input: CalculationInput
}>

export type CalculationRunSuccess = Readonly<{
  type: 'calculation-success'
  requestId: string
  revision: number
  sourceHash: string
  output: NormalizedCalculationOutput
}>

export type CalculationRunError = Readonly<{
  type: 'calculation-error'
  requestId: string
  revision: number
  sourceHash: string
  errorCode: CalculationExecutionErrorCode
  message: string
  diagnostic?: CalculationSourceDiagnostic
}>

export type CalculationRunResponse = CalculationRunSuccess | CalculationRunError

export type CalculationRunnerOperationEnvelope = Readonly<{
  type: 'calculate'
  nonce: string
  request: CalculationRunRequest
}>

export type CalculationRunnerStartedEnvelope = Readonly<{
  type: 'operation-started'
  operation: 'calculate'
  nonce: string
  requestId: string
  revision: number
  documentType: 'calculation'
}>

export type CalculationRunnerLogEnvelope = Readonly<{
  type: 'operation-log'
  operation: 'calculate'
  nonce: string
  requestId: string
  revision: number
  sourceHash: string
  sequence: number
  message: string
}>

export type CalculationRunnerResultEnvelope = Readonly<{
  type: 'operation-result'
  operation: 'calculate'
  nonce: string
  response: CalculationRunResponse
}>

function secureRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Calculation runner message is invalid.')
  return value as Record<string, unknown>
}

function secureIdentity(value: Record<string, unknown>) {
  if (typeof value.requestId !== 'string' || value.requestId.length < 1 || !Number.isSafeInteger(value.revision)) {
    throw new Error('Calculation runner identity is invalid.')
  }
}

function secureNonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/u.test(value)) {
    throw new Error('Calculation runner nonce is invalid.')
  }
}

function assertCalculationSourceDiagnostic(value: unknown): asserts value is CalculationSourceDiagnostic | undefined {
  if (value === undefined) return
  const diagnostic = secureRecord(value)
  const range = secureRecord(diagnostic.range)
  if (
    typeof diagnostic.message !== 'string' ||
    typeof diagnostic.sourceLine !== 'string' ||
    !Number.isSafeInteger(range.startLineNumber) ||
    (range.startLineNumber as number) < 1 ||
    !Number.isSafeInteger(range.startColumn) ||
    (range.startColumn as number) < 1 ||
    range.endLineNumber !== range.startLineNumber ||
    !Number.isSafeInteger(range.endColumn) ||
    (range.endColumn as number) < (range.startColumn as number) ||
    (range.startColumn as number) > (diagnostic.sourceLine as string).length + 1 ||
    (range.endColumn as number) > (diagnostic.sourceLine as string).length + 1
  ) {
    throw new Error('Calculation source diagnostic is invalid.')
  }
}

export function assertCalculationRunRequest(value: unknown): asserts value is CalculationRunRequest {
  const request = secureRecord(value)
  if (request.type !== 'calculate') throw new Error('Calculation runner operation is invalid.')
  secureIdentity(request)
  const compiled = secureRecord(request.compiledSource)
  if (typeof compiled.code !== 'string' || typeof compiled.sourceHash !== 'string') {
    throw new Error('Compiled Calculation source is invalid.')
  }
}

export function assertCalculationRunnerOperationEnvelope(
  value: unknown,
): asserts value is CalculationRunnerOperationEnvelope {
  const envelope = secureRecord(value)
  if (envelope.type !== 'calculate') throw new Error('Calculation runner operation is invalid.')
  secureNonce(envelope.nonce)
  assertCalculationRunRequest(envelope.request)
}

export function assertCalculationRunnerStartedEnvelope(
  value: unknown,
): asserts value is CalculationRunnerStartedEnvelope {
  const envelope = secureRecord(value)
  if (
    envelope.type !== 'operation-started' ||
    envelope.operation !== 'calculate' ||
    envelope.documentType !== 'calculation'
  ) {
    throw new Error('Calculation runner start is invalid.')
  }
  secureNonce(envelope.nonce)
  secureIdentity(envelope)
}

export function assertCalculationRunnerLogEnvelope(value: unknown): asserts value is CalculationRunnerLogEnvelope {
  const envelope = secureRecord(value)
  if (envelope.type !== 'operation-log' || envelope.operation !== 'calculate') {
    throw new Error('Calculation runner log is invalid.')
  }
  secureNonce(envelope.nonce)
  secureIdentity(envelope)
  if (
    typeof envelope.sourceHash !== 'string' ||
    !Number.isSafeInteger(envelope.sequence) ||
    (envelope.sequence as number) < 1 ||
    (envelope.sequence as number) > CALCULATION_LOG_MAX_ENTRIES + 1 ||
    typeof envelope.message !== 'string' ||
    encoder.encode(envelope.message as string).byteLength > CALCULATION_LOG_MAX_ENTRY_BYTES
  ) {
    throw new Error('Calculation runner log is invalid.')
  }
}

export function assertCalculationRunnerResultEnvelope(
  value: unknown,
): asserts value is CalculationRunnerResultEnvelope {
  const envelope = secureRecord(value)
  if (envelope.type !== 'operation-result' || envelope.operation !== 'calculate') {
    throw new Error('Calculation runner result is invalid.')
  }
  secureNonce(envelope.nonce)
  const response = secureRecord(envelope.response)
  if (response.type !== 'calculation-success' && response.type !== 'calculation-error') {
    throw new Error('Calculation runner response is invalid.')
  }
  secureIdentity(response)
  if (typeof response.sourceHash !== 'string') throw new Error('Calculation runner source identity is invalid.')
  if (response.type === 'calculation-error') {
    if (
      !calculationExecutionErrorCodes.includes(response.errorCode as CalculationExecutionErrorCode) ||
      typeof response.message !== 'string'
    ) {
      throw new Error('Calculation runner error is invalid.')
    }
    assertCalculationSourceDiagnostic(response.diagnostic)
    if (
      response.diagnostic !== undefined &&
      (response.diagnostic as CalculationSourceDiagnostic).message !== response.message
    ) {
      throw new Error('Calculation runner error diagnostic does not match its message.')
    }
  }
}

export function calculationRunnerRejectionEnvelope(
  value: unknown,
  error: unknown,
): CalculationRunnerResultEnvelope | undefined {
  try {
    const envelope = secureRecord(value)
    secureNonce(envelope.nonce)
    const request = secureRecord(envelope.request)
    if (envelope.type !== 'calculate') return undefined
    return {
      type: 'operation-result',
      operation: 'calculate',
      nonce: envelope.nonce,
      response: {
        type: 'calculation-error',
        requestId: String(request.requestId),
        revision: Number(request.revision),
        sourceHash:
          typeof request.compiledSource === 'object' &&
          request.compiledSource !== null &&
          'sourceHash' in request.compiledSource
            ? String(request.compiledSource.sourceHash)
            : '',
        errorCode: 'runtime',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  } catch {
    return undefined
  }
}
