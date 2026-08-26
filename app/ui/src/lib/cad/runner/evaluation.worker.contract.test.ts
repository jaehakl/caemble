import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import type { RunnerOperationEnvelope } from './protocol'
import { canonicalShapedCatalog } from './catalogProtocol.testFixture'

const responses: unknown[] = []
const reportedErrors: unknown[] = []
let rejectOperationResult = false
const workerScope = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage(message: unknown) {
    if (
      rejectOperationResult &&
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'operation-result'
    ) {
      throw new Error('postMessage failed')
    }
    responses.push(message)
  },
  reportError(error: unknown) {
    reportedErrors.push(error)
  },
}
const nonce = '12345678-90ab-cdef-1234-567890abcdef'
const sourceHash = 'c'.repeat(64)
const compiledExperiment: CompiledCadDocument = {
  apiVersion: 11,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'geometry.tsx': {
      apiVersion: 11,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'geometry.tsx',
      sourceHash,
      code: 'module.exports = {}',
    },
    'material.tsx': {
      apiVersion: 11,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'material.tsx',
      sourceHash,
      code: 'module.exports = {}',
    },
    'experiment.tsx': {
      apiVersion: 11,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'experiment.tsx',
      sourceHash,
      code: `const { experiment } = require('@caemble/core')
const Box = ({ id, size }) => h('box', { id, size })
module.exports.default = experiment({
  lengthUnit: 'mm', varsSchema: { width: { shape: [], min: 1, max: 10 } },
  geometry: ({ vars }) => h(Box, { id: 'body', size: [vars.width, 1, 1] }), recordedData: {},
})`,
    },
    'tasks/electric.tsx': {
      apiVersion: 11,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'tasks/electric.tsx',
      sourceHash,
      code: `const { defineTask } = require('@caemble/core')
module.exports.default = defineTask({
  kernel: { name: 'dc-current-density', version: '0.1.0' },
  config: () => ({ parameters: {}, initializations: [], boundaryConditions: [], outputs: [] }),
})`,
    },
  },
}

function dispatch(data: RunnerOperationEnvelope | unknown) {
  workerScope.onmessage?.({ data } as MessageEvent<unknown>)
}

describe('CAD runner Worker', () => {
  let readyMessage: unknown
  beforeAll(async () => {
    vi.stubGlobal('self', workerScope)
    await import('./evaluation.worker')
    readyMessage = responses[0]
  })
  beforeEach(() => {
    responses.length = 0
    reportedErrors.length = 0
    rejectOperationResult = false
  })
  afterAll(() => vi.unstubAllGlobals())

  it('inspects varsSchema without evaluating geometry', () => {
    expect(readyMessage).toEqual({ type: 'runner-worker-ready' })
    dispatch({
      type: 'inspect',
      nonce,
      request: {
        type: 'inspect',
        requestId: 'inspect-1',
        revision: 2,
        compiledDocument: compiledExperiment,
        catalog: canonicalShapedCatalog,
      },
    })
    expect(responses[0]).toMatchObject({
      type: 'operation-result',
      operation: 'inspect',
      nonce,
      response: { type: 'inspection-success', sourceHash, varsSchema: { width: { shape: [], min: 1, max: 10 } } },
    })
  })

  it('evaluates against the exact synthetic catalog slice', async () => {
    dispatch({
      type: 'evaluate',
      nonce,
      request: {
        type: 'evaluate',
        requestId: 'evaluate-1',
        revision: 3,
        compiledDocument: compiledExperiment,
        catalog: canonicalShapedCatalog,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        vars: { width: 2 },
      },
    })
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({
      type: 'operation-result',
      operation: 'evaluate',
      nonce,
      response: { type: 'evaluation-success', documentType: 'experiment' },
    })
  })

  it('evaluates the reserved Draft Task for preview without a fake Solver descriptor', async () => {
    const draftDocument: CompiledCadDocument = {
      ...compiledExperiment,
      sources: {
        ...compiledExperiment.sources,
        'tasks/electric.tsx': {
          ...compiledExperiment.sources['tasks/electric.tsx'],
          code: `const { defineTask } = require('@caemble/core')
module.exports.default = defineTask({
  kernel: { name: 'replace-with-solver', version: '1.0.0' },
  config: () => ({}),
})`,
        },
      },
    }
    dispatch({
      type: 'evaluate',
      nonce,
      request: {
        type: 'evaluate',
        requestId: 'evaluate-draft',
        revision: 4,
        compiledDocument: draftDocument,
        catalog: { ...canonicalShapedCatalog, solvers: [] },
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        vars: { width: 2 },
      },
    })
    await vi.waitFor(() => expect(responses).toHaveLength(1))
    expect(responses[0]).toMatchObject({
      type: 'operation-result',
      operation: 'evaluate',
      nonce,
      response: { type: 'evaluation-success', documentType: 'experiment' },
    })
  })

  it('rejects missing, extra, and invalid catalog data at the Worker boundary', () => {
    expect(() =>
      dispatch({
        type: 'inspect',
        nonce,
        request: { type: 'inspect', requestId: 'missing-1', revision: 4, compiledDocument: compiledExperiment },
      }),
    ).toThrow()
    expect(responses).toHaveLength(0)

    expect(() =>
      dispatch({
        type: 'inspect',
        nonce,
        request: {
          type: 'inspect',
          requestId: 'extra-1',
          revision: 5,
          compiledDocument: compiledExperiment,
          catalog: canonicalShapedCatalog,
          unexpected: true,
        },
      }),
    ).toThrow('request.unexpected is not allowed')
    expect(responses).toHaveLength(0)

    expect(() =>
      dispatch({
        type: 'inspect',
        nonce,
        request: {
          type: 'inspect',
          requestId: 'invalid-1',
          revision: 6,
          compiledDocument: compiledExperiment,
          catalog: { ...canonicalShapedCatalog, schemaVersion: 2 },
        },
      }),
    ).toThrow()
    expect(responses).toHaveLength(0)
  })

  it('reports catalog semantic errors after installing the slice', () => {
    dispatch({
      type: 'inspect',
      nonce,
      request: {
        type: 'inspect',
        requestId: 'semantic-invalid',
        revision: 7,
        compiledDocument: compiledExperiment,
        catalog: {
          ...canonicalShapedCatalog,
          quantityKinds: canonicalShapedCatalog.quantityKinds.map((entry) =>
            entry.name === 'DimensionlessRatio' ? { ...entry, applicableUnits: ['%'] } : entry,
          ),
        },
      },
    })
    expect(responses[0]).toMatchObject({
      type: 'operation-result',
      operation: 'inspect',
      response: {
        type: 'inspection-error',
        errorType: 'model',
        message: expect.stringContaining('is not applicable to DimensionlessRatio'),
      },
    })
  })

  it('reports asynchronous operation-result delivery failures to the Worker error boundary', async () => {
    rejectOperationResult = true
    dispatch({
      type: 'inspect',
      nonce,
      request: {
        type: 'inspect',
        requestId: 'delivery-failed',
        revision: 8,
        compiledDocument: compiledExperiment,
        catalog: canonicalShapedCatalog,
      },
    })

    await vi.waitFor(() => expect(reportedErrors).toHaveLength(1))
    expect(reportedErrors[0]).toEqual(expect.objectContaining({ message: 'postMessage failed' }))
  })
})
