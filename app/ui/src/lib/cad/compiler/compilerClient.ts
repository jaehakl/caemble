import CadCompilerWorker from './cadCompiler.worker?worker'
import { CadCompilationError } from './compilationError'
import type { CadCompilationInput, CadCompilationResponse } from './compilerProtocol'
import type { CompiledCadDocument } from './types'

type Consumer = {
  resolve: (document: CompiledCadDocument) => void
  reject: (cause: unknown) => void
  detach: () => void
}
type Compilation = {
  key: string
  requestId: number
  input: CadCompilationInput
  consumers: Set<Consumer>
}

const completed = new Map<string, CompiledCadDocument>()
const pending = new Map<string, Compilation>()
const queue: Compilation[] = []
let active: Compilation | null = null
let worker: Worker | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let requestSequence = 0

function finish(document: CompiledCadDocument | null, cause?: unknown, resetWorker = false) {
  if (resetWorker) {
    worker?.terminate()
    worker = null
  }
  const job = active
  if (!job) return
  clearTimeout(timer)
  timer = undefined
  active = null
  pending.delete(job.key)
  if (document) {
    Object.values(document.sources).forEach(Object.freeze)
    Object.freeze(document.sources)
    Object.freeze(document)
    // Abandoned active work is drained safely, but does not populate the cache.
    if (job.consumers.size) {
      completed.set(job.key, document)
      if (completed.size > 32) completed.delete(completed.keys().next().value!)
    }
  }
  for (const consumer of job.consumers) {
    consumer.detach()
    if (document) consumer.resolve(document)
    else consumer.reject(cause)
  }
  job.consumers.clear()
  queueMicrotask(startNext)
}

function startNext() {
  if (active) return
  const job = queue.shift()
  if (!job) return
  active = job
  timer = setTimeout(() => {
    finish(null, new CadCompilationError('compile', 'CAD compilation timed out after 30 seconds.'), true)
  }, 30_000)
  try {
    if (!worker) {
      const created = new CadCompilerWorker()
      worker = created
      created.onmessage = (event: MessageEvent<CadCompilationResponse>) => {
        if (worker !== created || !active || event.data?.requestId !== active.requestId) return
        const response = event.data
        if (response.type === 'success' && response.document?.sourceHash === active.input.sourceHash) {
          finish(response.document)
        } else if (response.type === 'failure') {
          finish(null, new CadCompilationError(response.errorType, response.message, response.diagnostics))
        } else {
          finish(null, new CadCompilationError('compile', 'The CAD compiler returned an invalid response.'), true)
        }
      }
      created.onerror = (event) => {
        if (worker !== created) return
        event.preventDefault()
        finish(null, new CadCompilationError('compile', event.message || 'The CAD compiler Worker failed.'), true)
      }
      created.onmessageerror = () => {
        if (worker !== created) return
        finish(null, new CadCompilationError('compile', 'The CAD compiler response could not be read.'), true)
      }
    }
    worker.postMessage({ ...job.input, type: 'compile-cad', requestId: job.requestId })
  } catch (cause) {
    finish(null, new CadCompilationError('compile', cause instanceof Error ? cause.message : String(cause)), true)
  }
}

export function compileInWorker(key: string, input: CadCompilationInput, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(new DOMException('The CAD compilation was aborted.', 'AbortError'))
  const cached = completed.get(key)
  if (cached) {
    completed.delete(key)
    completed.set(key, cached)
    return Promise.resolve(cached)
  }
  let job = pending.get(key)
  if (!job) {
    job = { key, requestId: ++requestSequence, input, consumers: new Set() }
    pending.set(key, job)
    queue.push(job)
  }
  const compilation = job
  return new Promise<CompiledCadDocument>((resolve, reject) => {
    const abort = () => {
      compilation.consumers.delete(consumer)
      consumer.detach()
      reject(new DOMException('The CAD compilation was aborted.', 'AbortError'))
      if (!compilation.consumers.size && compilation !== active) {
        pending.delete(compilation.key)
        const index = queue.indexOf(compilation)
        if (index !== -1) queue.splice(index, 1)
      }
    }
    const consumer: Consumer = { resolve, reject, detach: () => signal?.removeEventListener('abort', abort) }
    compilation.consumers.add(consumer)
    signal?.addEventListener('abort', abort, { once: true })
    startNext()
  })
}
