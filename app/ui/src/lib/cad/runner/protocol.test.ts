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
} from './protocol'

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
const compiledExperiment: CompiledCadDocument = {
  apiVersion: 7,
  compilerVersion: CAD_COMPILER_VERSION,
  sourceHash,
  sources: {
    'experiment.tsx': {
      apiVersion: 7,
      compilerVersion: CAD_COMPILER_VERSION,
      entryFile: 'experiment.tsx',
      code: 'module.exports.default = {}',
      sourceHash,
    },
  },
}
const geometryCoordinate = 'caemble:geometry/tester/synthetic/box@local'
const compiledGeometry = {
  ...compiledExperiment,
  geometryGraph: {
    graphHash: 'c'.repeat(64),
    entryImports: [{ exportName: 'Box', alias: 'Box', coordinate: geometryCoordinate, moduleHash: 'd'.repeat(64) }],
    modules: {
      [geometryCoordinate]: {
        apiVersion: 7,
        compilerVersion: CAD_COMPILER_VERSION,
        entryFile: geometryCoordinate,
        code: `exports.Box = ({ id = 'preview' }) => h('box', { id, size: [1, 1, 1] })`,
        sourceHash,
        geometrySourceHash: 'e'.repeat(64),
        moduleHash: 'd'.repeat(64),
        exports: ['Box'],
        imports: [],
      },
    },
  },
}

describe('isolated runner protocol v5', () => {
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

  it('keeps Geometry preview catalog-free', () => {
    const preview = {
      type: 'preview-geometry',
      requestId: 'preview-1',
      revision: 3,
      compiledDocument: compiledGeometry,
      coordinate: geometryCoordinate,
      exportName: 'Box',
      lengthUnit: 'mm',
    }
    expect(() => assertCadGeometryPreviewRequest(preview)).not.toThrow()
    expect(() => assertCadGeometryPreviewRequest({ ...preview, catalog: syntheticCatalog })).toThrow(
      'request.catalog is not allowed',
    )
  })
})
