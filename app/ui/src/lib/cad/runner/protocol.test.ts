import { describe, expect, it } from 'vitest'
import { CAD_COMPILER_VERSION, type CompiledCadDocument } from '../compiler/types'
import {
  assertCadEvaluationRequest,
  assertCadGeometryPreviewRequest,
  assertCadInspectionRequest,
  assertRunnerCancelOperationEnvelope,
  assertRunnerOperationEnvelope,
  assertRunnerOperationResultEnvelope,
  assertRunnerOperationStartedEnvelope,
  runnerOperationRejectionEnvelope,
} from './protocol'
import { canonicalShapedCatalog } from './catalogProtocol.testFixture'

const sourceHash = 'b'.repeat(64)
const nonce = '12345678-1234-1234-1234-123456789abc'
const syntheticCatalog = {
  schemaVersion: 1,
  catalogRevision: 'synthetic-runner-test',
  solvers: [],
  quantityKinds: [],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
} as const
const compiledSource = (entryFile: string, code = 'module.exports = {}') => ({
  apiVersion: 8 as const,
  compilerVersion: CAD_COMPILER_VERSION,
  entryFile,
  code,
  sourceHash,
})
const compiledExperiment: CompiledCadDocument = {
  apiVersion: 8,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'experiment.tsx': compiledSource('experiment.tsx', 'module.exports.default = {}'),
    'geometry.tsx': compiledSource(
      'geometry.tsx',
      `exports.Box = ({ id = 'preview' }) => h('box', { id, size: [1, 1, 1] })`,
    ),
    'material.tsx': compiledSource('material.tsx'),
  },
}

describe('isolated runner protocol for Experiment bundles', () => {
  it('accepts exact inspect, evaluate, start, result, and cancel messages', () => {
    const inspect = {
      type: 'inspect' as const,
      requestId: 'inspect-1',
      revision: 1,
      compiledDocument: compiledExperiment,
      catalog: syntheticCatalog,
    }
    const evaluate = {
      type: 'evaluate' as const,
      requestId: 'evaluate-1',
      revision: 2,
      compiledDocument: compiledExperiment,
      catalog: syntheticCatalog,
      pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
      vars: { width: 2 },
    }
    expect(() => assertCadInspectionRequest(inspect)).not.toThrow()
    expect(() => assertCadEvaluationRequest(evaluate)).not.toThrow()
    expect(() => assertRunnerOperationEnvelope({ type: 'inspect', nonce, request: inspect })).not.toThrow()
    expect(() =>
      assertRunnerOperationStartedEnvelope({
        type: 'operation-started',
        operation: 'inspect',
        nonce,
        requestId: inspect.requestId,
        revision: inspect.revision,
        documentType: 'experiment',
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerOperationResultEnvelope({
        type: 'operation-result',
        operation: 'inspect',
        nonce,
        response: {
          type: 'inspection-success',
          requestId: inspect.requestId,
          revision: inspect.revision,
          documentType: 'experiment',
          sourceHash,
          varsSchema: { width: { min: 1, max: 3 } },
        },
      }),
    ).not.toThrow()
    expect(() =>
      assertRunnerCancelOperationEnvelope({ type: 'cancel-operation', nonce, requestId: inspect.requestId }),
    ).not.toThrow()
  })

  it('rejects incomplete vars, extra fields, and mismatched operations', () => {
    const evaluate = {
      type: 'evaluate',
      requestId: 'evaluate-1',
      revision: 2,
      compiledDocument: compiledExperiment,
      catalog: syntheticCatalog,
      pythonSource: 'python',
      vars: {},
      elevated: true,
    }
    expect(() => assertCadEvaluationRequest(evaluate)).toThrow('request.elevated is not allowed')
    const { elevated, ...allowed } = evaluate
    expect(elevated).toBe(true)
    expect(() => assertCadEvaluationRequest({ ...allowed, vars: undefined })).toThrow('request.vars')
    expect(() =>
      assertRunnerOperationEnvelope({
        type: 'inspect',
        nonce,
        request: {
          type: 'evaluate',
          requestId: 'evaluate-1',
          revision: 2,
          compiledDocument: compiledExperiment,
          catalog: syntheticCatalog,
          pythonSource: 'x',
          vars: {},
        },
      }),
    ).toThrow('does not match')
  })

  it('requires a valid catalog slice for inspect and evaluate requests', () => {
    expect(() =>
      assertCadInspectionRequest({
        type: 'inspect',
        requestId: 'inspect-1',
        revision: 1,
        compiledDocument: compiledExperiment,
      }),
    ).toThrow()
    expect(() =>
      assertCadEvaluationRequest({
        type: 'evaluate',
        requestId: 'evaluate-1',
        revision: 2,
        compiledDocument: compiledExperiment,
        pythonSource: 'python',
        vars: {},
      }),
    ).toThrow()
    expect(() =>
      assertCadInspectionRequest({
        type: 'inspect',
        requestId: 'inspect-1',
        revision: 1,
        compiledDocument: compiledExperiment,
        catalog: { ...syntheticCatalog, schemaVersion: 2 },
      }),
    ).toThrow()
  })

  it('accepts a canonical-shaped Solver slice before catalog runtime installation', () => {
    expect(() =>
      assertCadInspectionRequest({
        type: 'inspect',
        requestId: 'inspect-canonical',
        revision: 1,
        compiledDocument: compiledExperiment,
        catalog: canonicalShapedCatalog,
      }),
    ).not.toThrow()
  })

  it('builds an immediate actionable rejection when invalid input still has safe routing identity', () => {
    const invalid = {
      type: 'inspect',
      nonce,
      request: {
        type: 'inspect',
        requestId: 'inspect-invalid',
        revision: 1,
        compiledDocument: compiledExperiment,
        catalog: { ...syntheticCatalog, schemaVersion: 2 },
      },
    }
    let validationError: unknown
    try {
      assertRunnerOperationEnvelope(invalid)
    } catch (error) {
      validationError = error
    }
    const rejection = runnerOperationRejectionEnvelope(invalid, validationError)
    expect(() => assertRunnerOperationResultEnvelope(rejection)).not.toThrow()
    expect(rejection).toMatchObject({
      type: 'operation-result',
      operation: 'inspect',
      nonce,
      response: {
        type: 'inspection-error',
        requestId: 'inspect-invalid',
        revision: 1,
        errorType: 'model',
      },
    })
    expect(rejection?.response).toMatchObject({ message: expect.stringContaining('schemaVersion') })
    expect(runnerOperationRejectionEnvelope({ type: 'inspect' }, validationError)).toBeUndefined()
  })

  it('validates the catalog slice needed by a full-bundle Geometry preview', () => {
    const preview = {
      type: 'preview-geometry',
      requestId: 'preview-1',
      revision: 3,
      catalog: syntheticCatalog,
      compiledDocument: compiledExperiment,
      path: 'geometry.tsx',
      exportName: 'Box',
      lengthUnit: 'mm',
    }
    expect(() => assertCadGeometryPreviewRequest(preview)).not.toThrow()
    const { catalog, ...withoutCatalog } = preview
    expect(catalog).toBe(syntheticCatalog)
    expect(() => assertCadGeometryPreviewRequest(withoutCatalog)).toThrow()
  })
})
