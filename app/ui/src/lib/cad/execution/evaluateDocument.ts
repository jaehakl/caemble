import { compileCadDocument } from '../compiler/monacoCompiler'
import { evaluateInIsolatedRunner } from '../runner/client'
import { assertCadEvaluationRequest } from '../runner/protocol'
import { EXPERIMENT_SIMULATION_PATH, assertCadSourceDocument, type CadEvaluationInput } from '../source/document'
import type { CadDiagnostic, CadEvaluationRequest } from '../worker/protocol'
import type { EvaluatedDocumentSnapshot } from './snapshot'

export type EvaluateDocumentOptions = Readonly<{
  signal?: AbortSignal
  timeoutMs?: 3000 | 10000 | 30000
}>

export class CadDocumentEvaluationError extends Error {
  readonly diagnostics: readonly CadDiagnostic[]

  constructor(message: string, diagnostics: readonly CadDiagnostic[] = []) {
    super(message)
    this.name = 'CadDocumentEvaluationError'
    this.diagnostics = diagnostics
  }
}

export async function evaluateDocument(
  input: CadEvaluationInput,
  options: EvaluateDocumentOptions = {},
): Promise<EvaluatedDocumentSnapshot> {
  assertCadSourceDocument(input.document)
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) {
    throw new CadDocumentEvaluationError('Evaluation seed must be a non-negative safe integer.')
  }
  if (options.signal?.aborted) throw new DOMException('The CAD evaluation was aborted.', 'AbortError')
  const compiledDocument = await compileCadDocument(input.document)
  const pythonSource =
    input.document.kind === 'experiment' ? input.document.sourceBundle.files[EXPERIMENT_SIMULATION_PATH] : null
  const request: CadEvaluationRequest = {
    type: 'evaluate',
    compiledDocument,
    document: {
      kind: input.document.kind,
      realizationSeed: input.seed,
      ...(pythonSource ? { pythonSource } : {}),
    },
    requestId: `evaluate-${crypto.randomUUID()}`,
    revision: 0,
    ...(input.vars ? { vars: input.vars } : {}),
  }
  assertCadEvaluationRequest(request)

  return new Promise<EvaluatedDocumentSnapshot>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 3000
    let settled = false
    let cancel: () => void = () => undefined
    let timeout: number | null = null
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timeout !== null) window.clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () =>
      finish(() => {
        cancel()
        reject(new DOMException('The CAD evaluation was aborted.', 'AbortError'))
      })
    options.signal?.addEventListener('abort', abort, { once: true })
    cancel = evaluateInIsolatedRunner(request, {
      onFailure(message) {
        finish(() => reject(new CadDocumentEvaluationError(message)))
      },
      onStart() {
        if (settled) return
        timeout = window.setTimeout(
          () =>
            finish(() => {
              cancel()
              reject(new CadDocumentEvaluationError(`Model evaluation timed out after ${timeoutMs / 1000} seconds.`))
            }),
          timeoutMs,
        )
      },
      onResponse(response) {
        if (response.type === 'evaluation-success') {
          finish(() => resolve(response.snapshot))
        } else {
          finish(() => reject(new CadDocumentEvaluationError(response.message, response.diagnostics)))
        }
      },
    })
  })
}
