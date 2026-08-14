import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import type { RunnerOperationEnvelope } from './protocol'

type MessageHandler = (event: MessageEvent<unknown>) => void
const handlers: MessageHandler[] = []
const readyMessages: Array<{ message: unknown; origin: string }> = []
class FakeWorker {
  static instances: FakeWorker[] = []
  messages: unknown[] = []
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: MessageHandler | null = null
  terminated = false
  constructor() { FakeWorker.instances.push(this) }
  postMessage(message: unknown) { this.messages.push(message) }
  terminate() { this.terminated = true }
}

const sourceHash = 'a'.repeat(64)
const compiled: CompiledCadDocument = {
  apiVersion: 6, compilerVersion: CAD_COMPILER_VERSION, sourceHash,
  sources: { 'experiment.tsx': { apiVersion: 6, compilerVersion: CAD_COMPILER_VERSION, entryFile: 'experiment.tsx', code: '', sourceHash } },
}
const inspection: RunnerOperationEnvelope = {
  type: 'inspect', nonce: '12345678-1234-1234-1234-123456789abc',
  request: { type: 'inspect', requestId: 'inspect-1', revision: 2, compiledDocument: compiled },
}

function createPort() {
  const messages: unknown[] = []
  return { messages, port: { closed: false, onmessage: null as MessageHandler | null, postMessage(message: unknown) { messages.push(message) }, start: vi.fn(), close() { this.closed = true } } }
}

describe('isolated runner frame', () => {
  beforeAll(async () => {
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('window', {
      location: { origin: 'http://127.0.0.1:5174', protocol: 'http:', port: '5174' },
      parent: { postMessage(message: unknown, origin: string) { readyMessages.push({ message, origin }) } },
      addEventListener(type: string, handler: MessageHandler) { if (type === 'message') handlers.push(handler) },
    })
    await import('./frame')
  })
  beforeEach(() => { FakeWorker.instances = [] })
  afterAll(() => vi.unstubAllGlobals())

  it('starts an inspection in a disposable Worker', () => {
    expect(readyMessages).toHaveLength(3)
    const { messages, port } = createPort()
    handlers[0]({ data: inspection, origin: 'http://localhost:5173', ports: [port] } as unknown as MessageEvent<unknown>)
    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    expect(messages[0]).toMatchObject({ type: 'operation-started', operation: 'inspect', documentType: 'experiment' })
    expect(worker.messages).toEqual([inspection])
  })
})
