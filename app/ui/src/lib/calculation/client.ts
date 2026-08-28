import { loadRunnerFrame } from '@/lib/cad/runner/client'
import type { RunnerCancelOperationEnvelope } from '@/lib/cad/runner/protocol'
import { compileCalculationSource } from './compiler'
import {
  assertCalculationRunnerResultEnvelope,
  assertCalculationRunnerStartedEnvelope,
  type CalculationRunRequest,
  type CalculationRunnerOperationEnvelope,
} from './protocol'
import { CalculationExecutionError, type CalculationInput, type CalculationOutput } from './types'
import { assertCalculationInput, normalizeCalculationOutput } from './validation'

const runnerStartupTimeoutMs = 10_000
let calculationRevision = 0

function executeCompiledCalculation(request: CalculationRunRequest, signal: AbortSignal | undefined) {
  return new Promise<CalculationOutput>((resolve, reject) => {
    const nonce = crypto.randomUUID()
    let finished = false
    let port: MessagePort | null = null
    let started = false
    const cleanup = () => {
      window.clearTimeout(startupTimeout)
      signal?.removeEventListener('abort', abort)
      port?.close()
      port = null
    }
    const fail = (error: unknown, cancelWorker = true) => {
      if (finished) return
      finished = true
      if (cancelWorker && port) {
        const cancellation: RunnerCancelOperationEnvelope = {
          type: 'cancel-operation',
          nonce,
          requestId: request.requestId,
        }
        port.postMessage(cancellation)
      }
      cleanup()
      reject(error)
    }
    const abort = () => fail(new CalculationExecutionError('cancelled', 'Calculation execution was cancelled.'))
    const startupTimeout = window.setTimeout(
      () =>
        fail(new CalculationExecutionError('runtime', 'The isolated Calculation runner did not initialize in time.')),
      runnerStartupTimeoutMs,
    )
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    void loadRunnerFrame()
      .then(({ frame, origin }) => {
        if (finished) return
        const targetWindow = frame.contentWindow
        if (!targetWindow) throw new Error('The isolated Calculation runner window is unavailable.')
        const channel = new MessageChannel()
        port = channel.port1
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          if (finished) return
          try {
            if (
              typeof event.data === 'object' &&
              event.data !== null &&
              'type' in event.data &&
              event.data.type === 'operation-started'
            ) {
              assertCalculationRunnerStartedEnvelope(event.data)
              if (
                started ||
                event.data.nonce !== nonce ||
                event.data.requestId !== request.requestId ||
                event.data.revision !== request.revision
              ) {
                throw new Error('The isolated Calculation runner start identity is invalid.')
              }
              started = true
              window.clearTimeout(startupTimeout)
              return
            }
            assertCalculationRunnerResultEnvelope(event.data)
            if (
              event.data.nonce !== nonce ||
              event.data.response.requestId !== request.requestId ||
              event.data.response.revision !== request.revision ||
              event.data.response.sourceHash !== request.compiledSource.sourceHash
            ) {
              throw new Error('The isolated Calculation runner response identity is invalid.')
            }
            if (event.data.response.type === 'calculation-error') {
              fail(new CalculationExecutionError(event.data.response.errorCode, event.data.response.message), false)
              return
            }
            const output = normalizeCalculationOutput(event.data.response.output)
            finished = true
            cleanup()
            resolve(output)
          } catch (error) {
            fail(
              error instanceof CalculationExecutionError
                ? error
                : new CalculationExecutionError('runtime', error instanceof Error ? error.message : String(error)),
            )
          }
        }
        channel.port1.onmessageerror = () => {
          fail(
            new CalculationExecutionError('runtime', 'The isolated Calculation runner response could not be decoded.'),
          )
        }
        channel.port1.start()
        const envelope: CalculationRunnerOperationEnvelope = { type: 'calculate', nonce, request }
        targetWindow.postMessage(envelope, origin, [channel.port2])
      })
      .catch((error: unknown) => {
        fail(
          error instanceof CalculationExecutionError
            ? error
            : new CalculationExecutionError('runtime', error instanceof Error ? error.message : String(error)),
        )
      })
  })
}

export async function runCalculation(options: {
  sourceCode: string
  input: CalculationInput
  signal?: AbortSignal
}): Promise<CalculationOutput> {
  if (options.signal?.aborted) throw new CalculationExecutionError('cancelled', 'Calculation execution was cancelled.')
  try {
    assertCalculationInput(options.input)
  } catch (error) {
    if (error instanceof CalculationExecutionError) throw error
    throw new CalculationExecutionError('runtime', error instanceof Error ? error.message : String(error))
  }
  let compiledSource
  try {
    compiledSource = await compileCalculationSource(options.sourceCode)
  } catch (error) {
    if (error instanceof CalculationExecutionError) throw error
    throw new CalculationExecutionError('compile', error instanceof Error ? error.message : String(error))
  }
  if (options.signal?.aborted) throw new CalculationExecutionError('cancelled', 'Calculation execution was cancelled.')
  calculationRevision = calculationRevision === Number.MAX_SAFE_INTEGER ? 1 : calculationRevision + 1
  return executeCompiledCalculation(
    {
      type: 'calculate',
      requestId: crypto.randomUUID(),
      revision: calculationRevision,
      compiledSource,
      input: options.input,
    },
    options.signal,
  )
}
