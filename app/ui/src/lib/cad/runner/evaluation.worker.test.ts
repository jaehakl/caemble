import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import type { RunnerOperationEnvelope } from './protocol'

const responses: unknown[] = []
const workerScope = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage(message: unknown) {
    responses.push(message)
  },
}
const nonce = '12345678-90ab-cdef-1234-567890abcdef'
const sourceHash = 'c'.repeat(64)
const compiledExperiment: CompiledCadDocument = {
  apiVersion: 5,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'geometry.tsx': {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'geometry.tsx',
      sourceHash,
      code: 'module.exports = {}',
    },
    'experiment.tsx': {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'experiment.tsx',
      sourceHash,
      code: `const { experiment } = require('@caemble/core')
module.exports.default = experiment({
  lengthUnit: 'mm', varsSchema: { width: { min: 1, max: 10 } },
  geometry: ({ vars }) => h('box', { id: 'body', size: [vars.width, 1, 1] }), recordedData: {},
})`,
    },
    'tasks/electric.tsx': {
      apiVersion: 5,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'tasks/electric.tsx',
      sourceHash,
      code: `const { defineTask } = require('@caemble/core')
module.exports.default = defineTask({ kernel: { name: 'test', version: '1' }, config: () => ({}) })`,
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
  })
  afterAll(() => vi.unstubAllGlobals())

  it('inspects varsSchema without evaluating geometry', () => {
    expect(readyMessage).toEqual({ type: 'runner-worker-ready' })
    dispatch({
      type: 'inspect',
      nonce,
      request: { type: 'inspect', requestId: 'inspect-1', revision: 2, compiledDocument: compiledExperiment },
    })
    expect(responses[0]).toMatchObject({
      type: 'operation-result',
      operation: 'inspect',
      nonce,
      response: { type: 'inspection-success', sourceHash, varsSchema: { width: { min: 1, max: 10 } } },
    })
  })
})
