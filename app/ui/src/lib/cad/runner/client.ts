import type { CadEvaluationRequest, CadEvaluationResponse } from '../worker/protocol'
import {
  assertRunnerEvaluationResultEnvelope,
  assertRunnerEvaluationStartedEnvelope,
  type RunnerCancelEvaluationEnvelope,
  type RunnerEvaluationEnvelope,
} from './protocol'

type EvaluationCallbacks = Readonly<{
  onFailure: (message: string) => void
  onResponse: (response: CadEvaluationResponse) => void
  onStart: () => void
}>

let runnerFrame: Promise<Readonly<{ frame: HTMLIFrameElement; origin: string }>> | null = null
const runnerStartupTimeoutMs = 10_000

function runnerLocation() {
  const configuredOrigin = import.meta.env.VITE_CAEMBLE_RUNNER_ORIGIN?.trim()
  if (!configuredOrigin) {
    if (import.meta.env.PROD) {
      throw new Error('VITE_CAEMBLE_RUNNER_ORIGIN must identify a separate runner origin in production.')
    }
    const hostPort = Number(window.location.port)
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort >= 65_535) {
      throw new Error('The development CAD runner requires an explicit host port.')
    }
    const url = new URL('/runner.html', window.location.origin)
    url.hostname = 'localhost'
    url.port = String(hostPort + 1)
    return url
  }
  const url = new URL('/runner.html', configuredOrigin)
  if (url.origin === window.location.origin) {
    throw new Error('The CAD runner must use an origin different from the host application.')
  }
  return url
}

function loadRunnerFrame() {
  runnerFrame ??= new Promise<Readonly<{ frame: HTMLIFrameElement; origin: string }>>((resolve, reject) => {
    let url: URL
    try {
      url = runnerLocation()
    } catch (error) {
      reject(error)
      return
    }
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    frame.referrerPolicy = 'no-referrer'
    const timeout = window.setTimeout(() => {
      cleanup()
      frame.remove()
      reject(new Error('The isolated CAD runner did not initialize in time.'))
    }, runnerStartupTimeoutMs)
    const cleanup = () => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', handleReady)
      frame.removeEventListener('error', handleError)
    }
    const handleReady = (event: MessageEvent<unknown>) => {
      if (
        event.source !== frame.contentWindow ||
        event.origin !== url.origin ||
        typeof event.data !== 'object' ||
        event.data === null ||
        Array.isArray(event.data) ||
        !('type' in event.data) ||
        event.data.type !== 'caemble-runner-frame-ready' ||
        Object.keys(event.data).length !== 1
      ) {
        return
      }
      cleanup()
      resolve(Object.freeze({ frame, origin: url.origin }))
    }
    const handleError = () => {
      cleanup()
      reject(new Error('The isolated CAD runner could not be loaded.'))
    }
    window.addEventListener('message', handleReady)
    frame.addEventListener('error', handleError, { once: true })
    frame.src = url.href
    document.body.append(frame)
  }).catch((error) => {
    runnerFrame = null
    throw error
  })
  return runnerFrame
}

export function evaluateInIsolatedRunner(request: CadEvaluationRequest, callbacks: EvaluationCallbacks) {
  const nonce = crypto.randomUUID()
  let cancelled = false
  let port: MessagePort | null = null
  let started = false
  const startupTimeout = window.setTimeout(() => {
    if (cancelled || started) return
    cancelled = true
    if (port) {
      const cancel: RunnerCancelEvaluationEnvelope = {
        type: 'cancel-evaluation',
        nonce,
        requestId: request.requestId,
      }
      port.postMessage(cancel)
      port.close()
      port = null
    }
    callbacks.onFailure(`The isolated CAD runner did not initialize within ${runnerStartupTimeoutMs / 1000} seconds.`)
  }, runnerStartupTimeoutMs)

  void loadRunnerFrame()
    .then(({ frame, origin }) => {
      if (cancelled) return
      const targetWindow = frame.contentWindow
      if (!targetWindow) throw new Error('The isolated CAD runner window is unavailable.')
      const channel = new MessageChannel()
      port = channel.port1
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        if (cancelled) return
        let keepPortOpen = false
        let failed = false
        try {
          if (
            typeof event.data === 'object' &&
            event.data !== null &&
            'type' in event.data &&
            event.data.type === 'evaluation-started'
          ) {
            assertRunnerEvaluationStartedEnvelope(event.data)
            if (
              started ||
              event.data.nonce !== nonce ||
              event.data.requestId !== request.requestId ||
              event.data.revision !== request.revision ||
              event.data.documentType !== request.document.kind
            ) {
              throw new Error('The isolated CAD runner start identity is invalid.')
            }
            started = true
            window.clearTimeout(startupTimeout)
            callbacks.onStart()
            keepPortOpen = true
            return
          }
          assertRunnerEvaluationResultEnvelope(event.data)
          if (
            event.data.nonce !== nonce ||
            event.data.response.requestId !== request.requestId ||
            event.data.response.revision !== request.revision ||
            event.data.response.documentType !== request.document.kind ||
            (event.data.response.type === 'evaluation-success' &&
              (event.data.response.snapshot.sourceHash !== request.compiledDocument.sourceHash ||
                event.data.response.snapshot.seed !== request.document.realizationSeed))
          ) {
            throw new Error('The isolated CAD runner response identity is invalid.')
          }
          callbacks.onResponse(event.data.response)
        } catch (error) {
          failed = true
          callbacks.onFailure(error instanceof Error ? error.message : String(error))
        } finally {
          if (!keepPortOpen) {
            window.clearTimeout(startupTimeout)
            if (failed) {
              const cancel: RunnerCancelEvaluationEnvelope = {
                type: 'cancel-evaluation',
                nonce,
                requestId: request.requestId,
              }
              channel.port1.postMessage(cancel)
            }
            channel.port1.close()
            port = null
          }
        }
      }
      channel.port1.onmessageerror = () => {
        window.clearTimeout(startupTimeout)
        callbacks.onFailure('The isolated CAD runner response could not be decoded.')
        const cancel: RunnerCancelEvaluationEnvelope = {
          type: 'cancel-evaluation',
          nonce,
          requestId: request.requestId,
        }
        channel.port1.postMessage(cancel)
        channel.port1.close()
        port = null
      }
      channel.port1.start()
      const envelope: RunnerEvaluationEnvelope = { type: 'evaluate', nonce, request }
      targetWindow.postMessage(envelope, origin, [channel.port2])
    })
    .catch((error: unknown) => {
      if (!cancelled) {
        window.clearTimeout(startupTimeout)
        callbacks.onFailure(error instanceof Error ? error.message : String(error))
      }
    })

  return () => {
    if (cancelled) return
    cancelled = true
    window.clearTimeout(startupTimeout)
    if (!port) return
    const cancel: RunnerCancelEvaluationEnvelope = {
      type: 'cancel-evaluation',
      nonce,
      requestId: request.requestId,
    }
    port.postMessage(cancel)
    port.close()
    port = null
  }
}
