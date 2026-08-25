import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import { cadSceneHash } from '../execution/meshValidation'
import { installCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { assertRunnerOperationResultEnvelope, type RunnerOperationEnvelope } from './protocol'
import { canonicalShapedCatalog } from './catalogProtocol.testFixture'

type MessageHandler = (event: MessageEvent<unknown>) => void
const handlers: MessageHandler[] = []
const readyMessages: Array<{ message: unknown; origin: string }> = []
class FakeWorker {
  static instances: FakeWorker[] = []
  messages: unknown[] = []
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

const sourceHash = 'a'.repeat(64)
const compiled: CompiledCadDocument = {
  apiVersion: 10,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'experiment.tsx': {
      apiVersion: 10,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'experiment.tsx',
      code: '',
      sourceHash,
    },
    'geometry.tsx': {
      apiVersion: 10,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'geometry.tsx',
      code: '',
      sourceHash,
    },
    'material.tsx': {
      apiVersion: 10,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'material.tsx',
      code: '',
      sourceHash,
    },
  },
}
const inspection: RunnerOperationEnvelope = {
  type: 'inspect',
  nonce: '12345678-1234-1234-1234-123456789abc',
  request: {
    type: 'inspect',
    requestId: 'inspect-1',
    revision: 2,
    compiledDocument: compiled,
    catalog: canonicalShapedCatalog,
  },
}
const emptySceneContent = {
  lengthUnit: 'mm' as const,
  parts: [],
  tree: { key: 'root', label: 'Root', children: [] },
  geometryGroups: [],
  surfaceGroups: [],
}
const emptyRenderScene = { sceneHash: cadSceneHash(emptySceneContent), ...emptySceneContent }
const emptyScene = {
  geometryFormatVersion: 1 as const,
  geometryHash: '925303f4dbe17be213b13881dbe3c16d804347ad95db75560fcab454731f3a76',
  lengthUnit: 'mm' as const,
  roots: [],
  geometryGroups: [],
  surfaceGroups: [],
}
const pythonSource = 'async def simulate(*, sim, tasks, vars):\n    return None\n'
const evaluation: RunnerOperationEnvelope = {
  type: 'evaluate',
  nonce: 'abcdef12-1234-1234-1234-123456789abc',
  request: {
    type: 'evaluate',
    requestId: 'evaluate-1',
    revision: 3,
    compiledDocument: compiled,
    catalog: canonicalShapedCatalog,
    pythonSource,
    vars: {},
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
          readyMessages.push({ message, origin })
        },
      },
      addEventListener(type: string, handler: MessageHandler) {
        if (type === 'message') handlers.push(handler)
      },
    })
    await import('./frame')
  })
  beforeEach(() => {
    FakeWorker.instances = []
  })
  afterAll(() => vi.unstubAllGlobals())

  it('starts an inspection in a disposable Worker', () => {
    expect(readyMessages).toHaveLength(3)
    const { messages, port } = createPort()
    handlers[0]({
      data: inspection,
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)
    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    expect(messages[0]).toMatchObject({ type: 'operation-started', operation: 'inspect', documentType: 'experiment' })
    expect(worker.messages).toEqual([inspection])
  })

  it('reinstalls the request catalog before validating a QuantityKind-backed evaluation result', () => {
    const { messages, port } = createPort()
    handlers[0]({
      data: evaluation,
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)
    const worker = FakeWorker.instances[0]
    worker.onmessage?.({ data: { type: 'runner-worker-ready' } } as MessageEvent<unknown>)
    installCatalogRuntimeSlice({
      ...canonicalShapedCatalog,
      catalogRevision: 'competing-concurrent-request',
      quantityKinds: canonicalShapedCatalog.quantityKinds.map((entry) =>
        entry.name === 'electromagnetism.ElectricCurrent' ? { ...entry, applicableUnits: ['mA'] } : entry,
      ),
    })
    worker.onmessage?.({
      data: {
        type: 'operation-result',
        operation: 'evaluate',
        nonce: evaluation.nonce,
        response: {
          type: 'evaluation-success',
          requestId: evaluation.request.requestId,
          revision: evaluation.request.revision,
          documentType: 'experiment',
          snapshot: {
            kind: 'experiment',
            sourceHash,
            variables: {},
            varsSchema: {},
            scene: emptyScene,
            taskScenes: { electric: emptyScene },
            renderScene: emptyRenderScene,
            taskRenderScenes: { electric: emptyRenderScene },
            simulationProgram: {
              formatVersion: 5,
              simulationApiVersion: 3,
              pythonSource,
              tasks: {
                electric: {
                  kernel: { name: 'dc-current-density', version: '0.1.0' },
                  config: {},
                },
              },
              recordedData: {
                current: {
                  dtype: 'float64',
                  quantityKind: 'electromagnetism.ElectricCurrent',
                  unit: 'A',
                  tensorOrder: 0,
                },
              },
            },
          },
        },
      },
    } as MessageEvent<unknown>)

    expect(messages).toHaveLength(2)
    expect(messages[1]).toMatchObject({
      type: 'operation-result',
      operation: 'evaluate',
      response: { type: 'evaluation-success' },
    })
    expect(worker.terminated).toBe(true)
    expect(port.closed).toBe(true)
  })

  it('returns an immediate model error when a routable operation envelope is invalid', () => {
    const { messages, port } = createPort()
    handlers[0]({
      data: {
        ...inspection,
        request: { ...inspection.request, catalog: { ...canonicalShapedCatalog, schemaVersion: 2 } },
      },
      origin: 'http://localhost:5173',
      ports: [port],
    } as unknown as MessageEvent<unknown>)

    expect(FakeWorker.instances).toHaveLength(0)
    expect(messages).toHaveLength(1)
    expect(() => assertRunnerOperationResultEnvelope(messages[0])).not.toThrow()
    expect(messages[0]).toMatchObject({
      type: 'operation-result',
      operation: 'inspect',
      response: {
        type: 'inspection-error',
        errorType: 'model',
        message: expect.stringContaining('schemaVersion'),
      },
    })
    expect(port.closed).toBe(true)
  })
})
