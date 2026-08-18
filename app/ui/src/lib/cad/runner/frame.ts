import { cadSnapshotTransferables } from '../execution/meshValidation'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import {
  assertRunnerCancelOperationEnvelope,
  assertRunnerOperationEnvelope,
  assertRunnerOperationResultEnvelope,
  runnerOperationRejectionEnvelope,
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
    worker = new Worker(new URL('./evaluation.worker.ts', import.meta.url), { type: 'module' })
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
              ...cadSnapshotTransferables(response.snapshot.scene),
              ...Object.values(response.snapshot.taskScenes).flatMap(cadSnapshotTransferables),
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

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.ports.length !== 1 || !allowedHostOrigins.has(event.origin)) return
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

allowedHostOrigins.forEach((origin) => {
  window.parent.postMessage({ type: 'caemble-runner-frame-ready' }, origin)
})
