import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadSource } from '../compiler/types'
import { buildSourceOnlyRealization, type BuiltSample, type BuiltSetup } from '../execution/realization'
import { serializeCadScene } from '../execution/mesh'
import type { EvaluatedExperimentSnapshot, EvaluatedStructureSnapshot } from '../execution/snapshot'
import type { RunnerEvaluationEnvelope, RunnerSimulationEnvelope } from './protocol'

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
const experimentSource = compiledSource('experiment.tsx')
const structureSnapshot: EvaluatedStructureSnapshot = {
  kind: 'structure',
  scene: serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [],
    surfaceGroups: [],
    tree: { children: [], key: 'structure', label: 'Structure' },
  }),
  seed: 7,
  sourceHash: structureSource.sourceHash,
  variables: {},
  varsSchema: {},
}
const experimentSnapshot: EvaluatedExperimentSnapshot = {
  kind: 'experiment',
  scene: serializeCadScene({
    geometryGroups: [],
    lengthUnit: 'mm',
    parts: [],
    surfaceGroups: [],
    tree: { children: [], key: 'experiment', label: 'Experiment' },
  }),
  seed: 9,
  sourceHash: experimentSource.sourceHash,
  variables: {},
  varsSchema: {},
  simulationProgram: {
    formatVersion: 1,
    programHash: experimentSource.sourceHash,
    tasks: {
      electric: {
        kernel: { name: 'dc-current-density', version: '0.0.0' },
        configHash: 'dc-config',
      },
    },
    recordedData: {
      measuredCurrent: {
        dtype: 'float64',
        unit: 'A',
        quantityKind: 'electromagnetism.ElectricCurrent',
      },
    },
  },
}
const sample = buildSourceOnlyRealization(structureSnapshot) as BuiltSample
const setup = buildSourceOnlyRealization(experimentSnapshot) as BuiltSetup
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
const simulation: RunnerSimulationEnvelope = {
  type: 'run-simulation',
  nonce: '87654321-4321-4321-4321-cba987654321',
  request: {
    type: 'run-simulation',
    requestId: 'simulation-1',
    structureRevision: 4,
    experimentRevision: 5,
    compiledSource: experimentSource,
    sample,
    setup,
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

  it('forwards simulation progress and cancellation to one disposable Worker', () => {
    vi.useFakeTimers()
    const { messages, port } = createPort()
    windowMessageHandlers[0]({
      data: simulation,
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)

    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    expect(messages).toEqual([
      {
        type: 'simulation-started',
        nonce: simulation.nonce,
        requestId: simulation.request.requestId,
        structureRevision: 4,
        experimentRevision: 5,
      },
    ])
    expect(worker.messages).toEqual([simulation])

    const progress = {
      type: 'simulation-progress',
      nonce: simulation.nonce,
      requestId: simulation.request.requestId,
      structureRevision: 4,
      experimentRevision: 5,
      progress: {
        runId: simulation.request.requestId,
        task: 'electric',
        kernel: { name: 'dc-current-density', version: '0.0.0' },
        stage: 'pcg',
        completed: 20,
        total: 100,
      },
    }
    worker.onmessage?.({ data: progress } as MessageEvent<unknown>)
    expect(messages[messages.length - 1]).toEqual(progress)
    expect(worker.terminated).toBe(false)

    const cancel = {
      type: 'cancel-simulation',
      nonce: simulation.nonce,
      requestId: simulation.request.requestId,
    } as const
    port.onmessage?.({ data: cancel } as MessageEvent<unknown>)
    expect(worker.messages).toEqual([simulation, cancel])
    expect(worker.terminated).toBe(false)

    vi.advanceTimersByTime(1_000)
    expect(worker.terminated).toBe(true)
    expect(port.closed).toBe(true)
    vi.useRealTimers()
  })

  it('does not start a simulation cancelled before the Worker is ready', () => {
    const { port } = createPort()
    windowMessageHandlers[0]({
      data: simulation,
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)

    const worker = FakeWorker.instances[0]
    port.onmessage?.({
      data: {
        type: 'cancel-simulation',
        nonce: simulation.nonce,
        requestId: simulation.request.requestId,
      },
    } as MessageEvent<unknown>)

    expect(worker.terminated).toBe(true)
    expect(worker.messages).toEqual([])
    expect(port.closed).toBe(true)

    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    expect(worker.messages).toEqual([])
  })
})
