import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CadCompilationRequest, CadCompilationResponse } from './compilerProtocol'

const mocks = vi.hoisted(() => {
  class Worker {
    onmessage?: (event: { data: CadCompilationResponse }) => void
    onerror?: (event: { message: string; preventDefault: () => void }) => void
    onmessageerror?: () => void
    postMessage = vi.fn<(request: CadCompilationRequest) => void>()
    terminate = vi.fn()
    constructor() {
      if (state.failStartup) {
        state.failStartup = false
        throw new Error('Worker startup failed')
      }
      state.workers.push(this)
    }
    succeed() {
      const request = this.postMessage.mock.lastCall![0]
      this.onmessage?.({
        data: {
          requestId: request.requestId,
          type: 'success',
          document: { sourceHash: request.sourceHash, sources: {} },
        },
      })
    }
  }
  const state = { workers: [] as Worker[], failStartup: false }
  return { Worker, state }
})

vi.mock('./cadCompiler.worker?worker', () => ({ default: mocks.Worker }))

const input = { sourceHash: 'source', sources: {}, catalogTypes: 'export {}' }

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  mocks.state.workers = []
  mocks.state.failStartup = false
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('isolated compiler scheduling', () => {
  it('shares pending work, cancels one consumer, and reuses a successful result', async () => {
    const { compileInWorker } = await import('./compilerClient')
    const abort = new AbortController()
    const preview = compileInWorker('same', input, abort.signal)
    const previewRejected = expect(preview).rejects.toMatchObject({ name: 'AbortError' })
    const workbench = compileInWorker('same', input)
    abort.abort()
    await previewRejected
    const worker = mocks.state.workers[0]
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    worker.succeed()
    const result = await workbench
    expect(await compileInWorker('same', input)).toBe(result)
    expect(Object.isFrozen(result)).toBe(true)
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('drops abandoned queued work and drains active work before the latest request', async () => {
    const { compileInWorker } = await import('./compilerClient')
    const firstAbort = new AbortController()
    const queuedAbort = new AbortController()
    const first = compileInWorker('first', input, firstAbort.signal)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const queued = compileInWorker('queued', input, queuedAbort.signal)
    const queuedRejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    const latest = compileInWorker('latest', input)
    firstAbort.abort()
    queuedAbort.abort()
    await Promise.all([firstRejected, queuedRejected])
    const worker = mocks.state.workers[0]
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
    worker.succeed()
    await Promise.resolve()
    expect(worker.postMessage).toHaveBeenCalledTimes(2)
    worker.succeed()
    await latest
    const retry = compileInWorker('first', input)
    expect(worker.postMessage).toHaveBeenCalledTimes(3)
    worker.succeed()
    await retry
  })

  it('reattaches an applied Template to its already running abandoned preview compile', async () => {
    const { compileInWorker } = await import('./compilerClient')
    const abort = new AbortController()
    const preview = compileInWorker('template', input, abort.signal)
    const rejected = expect(preview).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    const applied = compileInWorker('template', input)
    const worker = mocks.state.workers[0]
    worker.succeed()
    await applied
    expect(worker.postMessage).toHaveBeenCalledTimes(1)
  })

  it('does not cache type failures and continues queued work', async () => {
    const { compileInWorker } = await import('./compilerClient')
    const failing = compileInWorker('bad', input)
    const rejection = expect(failing).rejects.toMatchObject({ name: 'CadCompilationError', errorType: 'type' })
    const following = compileInWorker('good', input)
    const worker = mocks.state.workers[0]
    worker.onmessage?.({
      data: { requestId: 1, type: 'failure', errorType: 'type', message: 'invalid model', diagnostics: [] },
    })
    await rejection
    worker.succeed()
    await following
    const retry = compileInWorker('bad', input)
    expect(worker.postMessage).toHaveBeenCalledTimes(3)
    worker.succeed()
    await retry
  })

  it('recovers from a synchronous Worker initialization failure', async () => {
    const { compileInWorker } = await import('./compilerClient')
    mocks.state.failStartup = true
    await expect(compileInWorker('retry', input)).rejects.toThrow('Worker startup failed')
    const retried = compileInWorker('retry', input)
    mocks.state.workers[0].succeed()
    await retried
  })

  it.each(['timeout', 'error', 'messageerror'] as const)(
    'replaces a failed Worker after %s and ignores late replies',
    async (failure) => {
      const { compileInWorker } = await import('./compilerClient')
      const first = compileInWorker('first', input)
      const rejected = expect(first).rejects.toMatchObject({ errorType: 'compile' })
      const next = compileInWorker('next', input)
      const oldWorker = mocks.state.workers[0]
      if (failure === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
      else if (failure === 'error') oldWorker.onerror?.({ message: 'Worker crashed', preventDefault: vi.fn() })
      else oldWorker.onmessageerror?.()
      await rejected
      expect(oldWorker.terminate).toHaveBeenCalledTimes(1)
      expect(mocks.state.workers).toHaveLength(2)
      oldWorker.succeed()
      const newWorker = mocks.state.workers[1]
      expect(newWorker.postMessage).toHaveBeenCalledTimes(1)
      newWorker.succeed()
      await next
    },
  )

  it('keeps only 32 successful results and refreshes recency on a hit', async () => {
    const { compileInWorker } = await import('./compilerClient')
    for (let index = 0; index < 32; index += 1) {
      const compiled = compileInWorker(String(index), input)
      mocks.state.workers[0].succeed()
      await compiled
    }
    const worker = mocks.state.workers[0]
    await compileInWorker('0', input)
    const extra = compileInWorker('32', input)
    worker.succeed()
    await extra
    await compileInWorker('0', input)
    expect(worker.postMessage).toHaveBeenCalledTimes(33)
    const evicted = compileInWorker('1', input)
    expect(worker.postMessage).toHaveBeenCalledTimes(34)
    worker.succeed()
    await evicted
    expect(mocks.state.workers).toHaveLength(1)
  })
})
