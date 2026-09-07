/// <reference lib="webworker" />

import { executeCalculation } from './execute'
import { assertCalculationRunnerOperationEnvelope, type CalculationRunnerResultEnvelope } from './protocol'
import { CalculationExecutionError } from './types'

function handleOperation(value: unknown) {
  assertCalculationRunnerOperationEnvelope(value)
  const { nonce, request } = value
  let logSequence = 0
  const emitLog = (message: string) => {
    logSequence += 1
    self.postMessage({
      type: 'operation-log',
      operation: 'calculate',
      nonce,
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      sequence: logSequence,
      message,
    })
  }
  let response: CalculationRunnerResultEnvelope['response']
  try {
    response = {
      type: 'calculation-success',
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      output: executeCalculation(request.compiledSource, request.input, emitLog),
    }
  } catch (error) {
    response = {
      type: 'calculation-error',
      requestId: request.requestId,
      revision: request.revision,
      sourceHash: request.compiledSource.sourceHash,
      errorCode: error instanceof CalculationExecutionError ? error.code : 'runtime',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof CalculationExecutionError && error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    }
  }
  const envelope: CalculationRunnerResultEnvelope = {
    type: 'operation-result',
    operation: 'calculate',
    nonce,
    response,
  }
  self.postMessage(envelope)
}

self.onmessage = (event: MessageEvent<unknown>) => handleOperation(event.data)
self.postMessage({ type: 'runner-worker-ready' })

export {}
