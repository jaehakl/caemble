import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import type { RunnerEvaluationEnvelope } from './protocol'

type MessageHandler = (event: MessageEvent<unknown>) => void

const windowMessageHandlers: MessageHandler[] = []
const frameReadyMessages: Array<Readonly<{ message: unknown; origin: string }>> = []

class FakeWorker {
  static instances: FakeWorker[] = []
  readonly messages: unknown[] = []
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: MessageHandler | null = null
  terminated = false

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: unknown) {
    this.messages.push(message)
  }

  terminate() {
    this.terminated = true
  }
}

function compiledSource(entryFile: 'structure.tsx' | 'experiment.tsx'): CompiledCadSource {
  return {
    apiVersion: 3,
    compilerVersion: CAD_COMPILER_VERSION,
    entryFile,
    code: 'module.exports.default = {}',
    sourceHash: (entryFile === 'structure.tsx' ? 'a' : 'b').repeat(64),
  }
}

const structureSource = compiledSource('structure.tsx')
const evaluation: RunnerEvaluationEnvelope = {
  type: 'evaluate',
  nonce: '12345678-1234-1234-1234-123456789abc',
  request: {
    type: 'evaluate',
    requestId: 'evaluation-1',
    revision: 2,
    document: { kind: 'structure', realizationSeed: 7 },
    compiledSource: structureSource,
  },
}
const simulation = {
  type: 'run-simulation',
  nonce: '87654321-4321-4321-4321-cba987654321',
  request: {
    type: 'run-simulation',
    requestId: 'simulation-1',
  },
}

function createPort() {
  const messages: unknown[] = []
  return {
    messages,
    port: {
      closed: false,
      onmessage: null as MessageHandler | null,
      postMessage(message: unknown) {
        messages.push(message)
      },
      start: vi.fn(),
      close() {
        this.closed = true
      },
    },
  }
}

describe('isolated runner frame', () => {
  beforeAll(async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:5174', protocol: 'http:', port: '5174' },
      parent: {
        postMessage(message: unknown, origin: string) {
          frameReadyMessages.push({ message, origin })
        },
      },
      addEventListener(type: string, handler: MessageHandler) {
        if (type === 'message') windowMessageHandlers.push(handler)
      },
      setTimeout(handler: TimerHandler, timeout?: number) {
        return globalThis.setTimeout(handler, timeout)
      },
      clearTimeout(handle?: number) {
        globalThis.clearTimeout(handle)
      },
    })
    await import('./frame')
  })

  beforeEach(() => {
    FakeWorker.instances = []
  })

  afterAll(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('accepts only an allowed host and starts evaluation after the disposable Worker is ready', () => {
    expect(frameReadyMessages).toEqual([
      { message: { type: 'caemble-runner-frame-ready' }, origin: 'http://127.0.0.1:5173' },
      { message: { type: 'caemble-runner-frame-ready' }, origin: 'http://localhost:5173' },
      { message: { type: 'caemble-runner-frame-ready' }, origin: 'http://[::1]:5173' },
    ])
    const { messages, port } = createPort()

    windowMessageHandlers[0]({
      data: evaluation,
      origin: 'http://127.0.0.1:5172',
      ports: [port],
    } as unknown as MessageEvent<unknown>)
    expect(FakeWorker.instances).toEqual([])

    windowMessageHandlers[0]({
      data: evaluation,
      origin: 'http://127.0.0.1:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)
    const worker = FakeWorker.instances[0]
    expect(worker.messages).toEqual([])

    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    expect(messages).toEqual([
      {
        type: 'evaluation-started',
        nonce: evaluation.nonce,
        requestId: evaluation.request.requestId,
        revision: evaluation.request.revision,
        documentType: 'structure',
      },
    ])
    expect(worker.messages).toEqual([evaluation])

    worker.onmessage?.({
      data: {
        type: 'evaluation-result',
        nonce: evaluation.nonce,
        response: {
          type: 'evaluation-error',
          requestId: evaluation.request.requestId,
          revision: evaluation.request.revision,
          documentType: 'structure',
          errorType: 'runtime',
          message: 'test failure',
        },
      },
    } as MessageEvent<unknown>)

    expect(messages).toHaveLength(2)
    expect(worker.terminated).toBe(true)
    expect(port.closed).toBe(true)
  })

  it('ignores simulation messages without creating a Worker', () => {
    const { messages, port } = createPort()
    windowMessageHandlers[0]({
      data: simulation,
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)

    expect(FakeWorker.instances).toEqual([])
    expect(messages).toEqual([])
    expect(port.start).not.toHaveBeenCalled()
    expect(port.closed).toBe(false)
  })
})
