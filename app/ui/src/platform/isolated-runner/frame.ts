import { cadSnapshotTransferables } from '@/lib/cad/execution/meshSerialization'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import {
  assertCalculationRunnerOperationEnvelope,
  assertCalculationRunnerLogEnvelope,
  assertCalculationRunnerResultEnvelope,
  calculationRunnerRejectionEnvelope,
  type CalculationRunnerOperationEnvelope,
} from '@/lib/calculation/protocol'
import { CALCULATION_TIMEOUT_MS, type CalculationExecutionErrorCode } from '@/lib/calculation/types'
import {
  assertRunnerCancelOperationEnvelope,
  assertRunnerOperationEnvelope,
  assertRunnerOperationResultEnvelope,
  runnerOperationRejectionEnvelope,
  resolveRunnerReadyHostOrigin,
  type RunnerOperationEnvelope,
} from './protocol'

const configuredHostOrigin = import.meta.env.VITE_CAEMBLE_HOST_ORIGIN?.trim()
const runnerPort = Number(window.location.port)
const developmentHostPort = runnerPort - 1
const allowedHostOrigins = configuredHostOrigin
  ? new Set([new URL(configuredHostOrigin).origin])
  : import.meta.env.DEV && Number.isInteger(developmentHostPort) && developmentHostPort > 0
    ? new Set([
        `${window.location.protocol}//127.0.0.1:${developmentHostPort}`,
        `${window.location.protocol}//localhost:${developmentHostPort}`,
        `${window.location.protocol}//[::1]:${developmentHostPort}`,
      ])
    : new Set<string>()
const activeWorkers = new Map<string, Worker>()
const readyHostOrigin = configuredHostOrigin
  ? new URL(configuredHostOrigin).origin
  : resolveRunnerReadyHostOrigin(window.location.search, allowedHostOrigins)

function handleOperation(event: MessageEvent<unknown>, envelope: RunnerOperationEnvelope) {
  const { nonce, request, type: operation } = envelope
  if (activeWorkers.has(nonce)) return
  const port = event.ports[0]
  const postRuntimeError = (message: string) => {
    port.postMessage({
      type: 'operation-result',
      operation,
      nonce,
      response: {
        type:
          operation === 'inspect'
            ? 'inspection-error'
            : operation === 'evaluate'
              ? 'evaluation-error'
              : 'geometry-preview-error',
        requestId: request.requestId,
        revision: request.revision,
        documentType: operation === 'preview-geometry' ? 'geometry' : 'experiment',
        errorType: 'runtime',
        message,
      },
    })
  }
  let worker: Worker
  try {
    worker = new Worker(new URL('../../lib/cad/runner/evaluation.worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    postRuntimeError(error instanceof Error ? error.message : 'The CAD runner Worker could not be created.')
    port.close()
    return
  }
  activeWorkers.set(nonce, worker)
  let finished = false
  let started = false
  const finish = () => {
    if (finished) return
    finished = true
    activeWorkers.delete(nonce)
    worker.terminate()
    port.close()
  }
  worker.onmessage = (workerEvent: MessageEvent<unknown>) => {
    let keepWorker = false
    try {
      if (!started) {
        if (
          typeof workerEvent.data !== 'object' ||
          workerEvent.data === null ||
          Array.isArray(workerEvent.data) ||
          !('type' in workerEvent.data) ||
          workerEvent.data.type !== 'runner-worker-ready' ||
          Object.keys(workerEvent.data).length !== 1
        )
          throw new Error('The CAD runner Worker did not send a valid ready signal.')
        started = true
        port.postMessage({
          type: 'operation-started',
          operation,
          nonce,
          requestId: request.requestId,
          revision: request.revision,
          documentType: operation === 'preview-geometry' ? 'geometry' : 'experiment',
        })
        worker.postMessage(envelope)
        keepWorker = true
        return
      }
      if (request.type !== 'preview-geometry') installCatalogRuntimeSlice(request.catalog)
      assertRunnerOperationResultEnvelope(workerEvent.data)
      if (
        workerEvent.data.operation !== operation ||
        workerEvent.data.nonce !== nonce ||
        workerEvent.data.response.requestId !== request.requestId ||
        workerEvent.data.response.revision !== request.revision
      )
        throw new Error('The CAD runner Worker response identity is invalid.')
      const response = workerEvent.data.response
      port.postMessage(
        workerEvent.data,
        response.type === 'evaluation-success'
          ? [
              ...cadSnapshotTransferables(response.snapshot.renderScene),
              ...Object.values(response.snapshot.taskRenderScenes).flatMap(cadSnapshotTransferables),
            ]
          : response.type === 'geometry-preview-success'
            ? cadSnapshotTransferables(response.scene)
            : [],
      )
    } catch (error) {
      postRuntimeError(error instanceof Error ? error.message : 'The CAD runner Worker returned an invalid response.')
    } finally {
      if (!keepWorker) finish()
    }
  }
  worker.onerror = (workerError) => {
    postRuntimeError(workerError.message || 'The CAD runner Worker failed.')
    finish()
  }
  port.onmessage = (portEvent: MessageEvent<unknown>) => {
    try {
      assertRunnerCancelOperationEnvelope(portEvent.data)
      if (portEvent.data.nonce === nonce && portEvent.data.requestId === request.requestId) finish()
    } catch {
      // Invalid control messages cannot affect the Worker.
    }
  }
  port.start()
}

function handleCalculationOperation(event: MessageEvent<unknown>, envelope: CalculationRunnerOperationEnvelope) {
  const { nonce, request } = envelope
  if (activeWorkers.has(nonce)) return
  const port = event.ports[0]
  const postRuntimeError = (errorCode: CalculationExecutionErrorCode, message: string) => {
    port.postMessage({
      type: 'operation-result',
      operation: 'calculate',
      nonce,
      response: {
        type: 'calculation-error',
        requestId: request.requestId,
        revision: request.revision,
        sourceHash: request.compiledSource.sourceHash,
        errorCode,
        message,
      },
    })
  }
  let worker: Worker
  try {
    worker = new Worker(new URL('../../lib/calculation/runner.worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    postRuntimeError('runtime', error instanceof Error ? error.message : 'The Calculation Worker could not be created.')
    port.close()
    return
  }
  activeWorkers.set(nonce, worker)
  let finished = false
  let started = false
  const finish = () => {
    if (finished) return
    finished = true
    window.clearTimeout(timeout)
    activeWorkers.delete(nonce)
    worker.terminate()
    port.close()
  }
  const timeout = window.setTimeout(() => {
    if (finished) return
    postRuntimeError('timeout', `Calculation exceeded the ${CALCULATION_TIMEOUT_MS / 1000} second execution limit.`)
    finish()
  }, CALCULATION_TIMEOUT_MS)
  worker.onmessage = (workerEvent: MessageEvent<unknown>) => {
    let keepWorker = false
    try {
      if (!started) {
        if (
          typeof workerEvent.data !== 'object' ||
          workerEvent.data === null ||
          Array.isArray(workerEvent.data) ||
          !('type' in workerEvent.data) ||
          workerEvent.data.type !== 'runner-worker-ready' ||
          Object.keys(workerEvent.data).length !== 1
        ) {
          throw new Error('The Calculation Worker did not send a valid ready signal.')
        }
        started = true
        port.postMessage({
          type: 'operation-started',
          operation: 'calculate',
          nonce,
          requestId: request.requestId,
          revision: request.revision,
          documentType: 'calculation',
        })
        worker.postMessage(envelope)
        keepWorker = true
        return
      }
      if (
        typeof workerEvent.data === 'object' &&
        workerEvent.data !== null &&
        'type' in workerEvent.data &&
        workerEvent.data.type === 'operation-log'
      ) {
        assertCalculationRunnerLogEnvelope(workerEvent.data)
        if (
          workerEvent.data.nonce !== nonce ||
          workerEvent.data.requestId !== request.requestId ||
          workerEvent.data.revision !== request.revision ||
          workerEvent.data.sourceHash !== request.compiledSource.sourceHash
        ) {
          throw new Error('The Calculation Worker log identity is invalid.')
        }
        port.postMessage(workerEvent.data)
        keepWorker = true
        return
      }
      assertCalculationRunnerResultEnvelope(workerEvent.data)
      if (
        workerEvent.data.nonce !== nonce ||
        workerEvent.data.response.requestId !== request.requestId ||
        workerEvent.data.response.revision !== request.revision ||
        workerEvent.data.response.sourceHash !== request.compiledSource.sourceHash
      ) {
        throw new Error('The Calculation Worker response identity is invalid.')
      }
      port.postMessage(workerEvent.data)
    } catch (error) {
      postRuntimeError(
        'runtime',
        error instanceof Error ? error.message : 'The Calculation Worker returned an invalid response.',
      )
    } finally {
      if (!keepWorker) finish()
    }
  }
  worker.onerror = (workerError) => {
    postRuntimeError('runtime', workerError.message || 'The Calculation Worker failed.')
    finish()
  }
  port.onmessage = (portEvent: MessageEvent<unknown>) => {
    try {
      assertRunnerCancelOperationEnvelope(portEvent.data)
      if (portEvent.data.nonce === nonce && portEvent.data.requestId === request.requestId) finish()
    } catch {
      // Invalid control messages cannot affect the Worker.
    }
  }
  port.start()
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.ports.length !== 1 || !allowedHostOrigins.has(event.origin)) return
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    !Array.isArray(event.data) &&
    'type' in event.data &&
    event.data.type === 'calculate'
  ) {
    try {
      assertCalculationRunnerOperationEnvelope(event.data)
      handleCalculationOperation(event, event.data)
    } catch (error) {
      const rejection = calculationRunnerRejectionEnvelope(event.data, error)
      if (!rejection) return
      try {
        event.ports[0].postMessage(rejection)
      } finally {
        event.ports[0].close()
      }
    }
    return
  }
  try {
    assertRunnerOperationEnvelope(event.data)
    handleOperation(event, event.data)
  } catch (error) {
    const rejection = runnerOperationRejectionEnvelope(event.data, error)
    if (!rejection) return
    try {
      event.ports[0].postMessage(rejection)
    } finally {
      event.ports[0].close()
    }
  }
})

if (readyHostOrigin) window.parent.postMessage({ type: 'caemble-runner-frame-ready' }, readyHostOrigin)
