import {
  assertRunnerCancelEvaluationEnvelope,
  assertRunnerEvaluationEnvelope,
  assertRunnerEvaluationResultEnvelope,
  type RunnerEvaluationEnvelope,
} from './protocol'
import { cadSnapshotTransferables } from '../execution/meshValidation'

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

function handleEvaluation(event: MessageEvent<unknown>, envelope: RunnerEvaluationEnvelope) {
  const { nonce, request } = envelope
  if (activeWorkers.has(nonce)) return
  const port = event.ports[0]
  const postRuntimeError = (message: string) => {
    port.postMessage({
      type: 'evaluation-result',
      nonce,
      response: {
        type: 'evaluation-error',
        requestId: request.requestId,
        revision: request.revision,
        documentType: request.document.kind,
        errorType: 'runtime',
        message,
      },
    })
  }
  let worker: Worker
  try {
    worker = new Worker(new URL('./evaluation.worker.ts', import.meta.url), { type: 'module' })
  } catch (error) {
    postRuntimeError(error instanceof Error ? error.message : 'The evaluation Worker could not be created.')
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
        ) {
          throw new Error('The evaluation Worker did not send a valid ready signal.')
        }
        started = true
        port.postMessage({
          type: 'evaluation-started',
          nonce,
          requestId: request.requestId,
          revision: request.revision,
          documentType: request.document.kind,
        })
        worker.postMessage(envelope)
        keepWorker = true
        return
      }
      assertRunnerEvaluationResultEnvelope(workerEvent.data)
      if (
        workerEvent.data.nonce !== nonce ||
        workerEvent.data.response.requestId !== request.requestId ||
        workerEvent.data.response.revision !== request.revision ||
        workerEvent.data.response.documentType !== request.document.kind
      ) {
        throw new Error('The evaluation Worker response identity is invalid.')
      }
      port.postMessage(
        workerEvent.data,
        workerEvent.data.response.type === 'evaluation-success'
          ? workerEvent.data.response.snapshot.kind === 'structure'
            ? cadSnapshotTransferables(workerEvent.data.response.snapshot.scene)
            : Object.values(workerEvent.data.response.snapshot.taskScenes).flatMap(cadSnapshotTransferables)
          : [],
      )
    } catch (error) {
      postRuntimeError(error instanceof Error ? error.message : 'The evaluation Worker returned an invalid response.')
    } finally {
      if (!keepWorker) finish()
    }
  }
  worker.onerror = (workerError) => {
    postRuntimeError(workerError.message || 'The evaluation Worker failed.')
    finish()
  }
  port.onmessage = (portEvent: MessageEvent<unknown>) => {
    try {
      assertRunnerCancelEvaluationEnvelope(portEvent.data)
      if (portEvent.data.nonce === nonce && portEvent.data.requestId === request.requestId) finish()
    } catch {
      // Invalid control messages cannot affect the evaluation Worker.
    }
  }
  port.start()
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.ports.length !== 1 || !allowedHostOrigins.has(event.origin)) return
  try {
    assertRunnerEvaluationEnvelope(event.data)
    handleEvaluation(event, event.data)
  } catch {
    // Invalid cross-origin messages are ignored.
  }
})

allowedHostOrigins.forEach((origin) => {
  window.parent.postMessage({ type: 'caemble-runner-frame-ready' }, origin)
})
