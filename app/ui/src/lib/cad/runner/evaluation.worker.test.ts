import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import type { RunnerEvaluationEnvelope } from './protocol'

const responses: unknown[] = []
const workerScope = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage(message: unknown) {
    responses.push(message)
  },
}
const nonce = '12345678-90ab-cdef-1234-567890abcdef'
const structureHash = 'c'.repeat(64)
const compiledStructure: CompiledCadDocument = {
  apiVersion: 4,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash: structureHash,
  sources: {
    'structure.tsx': {
      apiVersion: 4,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'structure.tsx',
      sourceHash: structureHash,
      code: `
const { structure } = require('@caemble/core')
function Body({ width }) {
  return h('box', { size: [width, 1, 1] })
}
module.exports.default = structure({
  lengthUnit: 'mm',
  varsSchema: { width: { min: 1, max: 10 } },
  geometry: ({ vars }) => h(Body, { id: 'body', width: vars.width }),
})
`,
    },
  },
}

function dispatch(data: RunnerEvaluationEnvelope | unknown) {
  workerScope.onmessage?.({ data } as MessageEvent<unknown>)
}

describe('evaluation Worker', () => {
  let readyMessage: unknown

  beforeAll(async () => {
    vi.stubGlobal('self', workerScope)
    await import('./evaluation.worker')
    readyMessage = responses[0]
  })

  beforeEach(() => {
    responses.length = 0
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('announces readiness and evaluates an unversioned single-file Structure', () => {
    expect(readyMessage).toEqual({ type: 'runner-worker-ready' })
    dispatch({
      type: 'evaluate',
      nonce,
      request: {
        type: 'evaluate',
        requestId: 'evaluation-1',
        revision: 2,
        document: { kind: 'structure', realizationSeed: 7 },
        compiledDocument: compiledStructure,
        vars: { width: 4 },
      },
    })

    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({
      type: 'evaluation-result',
      nonce,
      response: {
        type: 'evaluation-success',
        requestId: 'evaluation-1',
        revision: 2,
        documentType: 'structure',
        snapshot: {
          kind: 'structure',
          seed: 7,
          variables: { width: 4 },
        },
      },
    })
  })

  it('rejects simulation messages without executing them', () => {
    expect(() =>
      dispatch({
        type: 'run-simulation',
        nonce,
        request: {
          type: 'run-simulation',
          requestId: 'run-1',
        },
      }),
    ).toThrow('Runner evaluation type is invalid')
    expect(responses).toEqual([])
  })
})
