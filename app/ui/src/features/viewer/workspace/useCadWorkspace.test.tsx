import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluatedExperimentSnapshot } from '@/lib/cad/execution'
import type { ExperimentSourceDocument } from '@/lib/cad/source'
import { useCadWorkspace } from './useCadWorkspace'

const mocks = vi.hoisted(() => ({
  applyFrozenMaterialParameters: vi.fn(),
  buildMeasurement: vi.fn(),
  deserializeCadScene: vi.fn(),
  evaluateDocument: vi.fn(),
  fetchCatalogRuntimeSlice: vi.fn(),
  inspectDocument: vi.fn(),
  resolveDocumentMaterials: vi.fn(),
}))

vi.mock('@/features/cae/client', () => ({
  releaseRecordedDataAttachments: vi.fn(),
  simulate: vi.fn(),
}))

vi.mock('@/features/runtime-console/types', () => ({ emitRuntimeActivity: vi.fn() }))

vi.mock('@/lib/cad/compiler/monacoCompiler', () => {
  class CadCompilationError extends Error {}
  return { CadCompilationError }
})

vi.mock('@/lib/cad/execution', () => {
  class CadDocumentEvaluationError extends Error {}
  return {
    applyFrozenMaterialParameters: mocks.applyFrozenMaterialParameters,
    buildMeasurement: mocks.buildMeasurement,
    CadDocumentEvaluationError,
    deserializeCadScene: mocks.deserializeCadScene,
    evaluateDocument: mocks.evaluateDocument,
    inspectDocument: mocks.inspectDocument,
    unresolvedMeasurementMaterialRoles: vi.fn(() => []),
  }
})

vi.mock('@/lib/cad/model', () => ({
  generateRandomVars: vi.fn(() => Object.freeze({})),
  normalizeVars: vi.fn((_schema, vars) => vars),
  normalizeVarsSchema: vi.fn((schema) => schema),
  varsSchemaFingerprint: vi.fn(() => 'schema-v1'),
}))

vi.mock('@/lib/cad/source', () => {
  const keepDocument = (document: unknown) => document
  return {
    EXPERIMENT_SIMULATION_PATH: 'simulate.py',
    addExperimentSourceFile: keepDocument,
    addExperimentTask: keepDocument,
    removeExperimentSourceFile: keepDocument,
    removeExperimentTask: keepDocument,
    updateCadSource: keepDocument,
    updateExperimentSourceFile: keepDocument,
  }
})

vi.mock('@/lib/catalog/runtime', () => ({ sourceCatalogRuntimeSlice: vi.fn(() => Object.freeze({})) }))
vi.mock('@/lib/catalog/solverTasks', () => ({ catalogDraftTaskNames: vi.fn(() => []) }))
vi.mock('../persistence/resolveMaterials', () => ({ resolveDocumentMaterials: mocks.resolveDocumentMaterials }))
vi.mock('./catalogRuntime', () => ({ fetchCatalogRuntimeSlice: mocks.fetchCatalogRuntimeSlice }))

const firstExperiment: ExperimentSourceDocument = Object.freeze({
  kind: 'experiment',
  sourceBundle: Object.freeze({ files: Object.freeze({ 'experiment.tsx': 'export default 1' }) }),
})
const secondExperiment: ExperimentSourceDocument = Object.freeze({
  kind: 'experiment',
  sourceBundle: Object.freeze({ files: Object.freeze({ 'experiment.tsx': 'export default 2' }) }),
})
const firstCandidateVars: Readonly<Record<string, number>> = Object.freeze({ x: 1 })
const secondCandidateVars: Readonly<Record<string, number>> = Object.freeze({ x: 2 })

function evaluatedSnapshot(sourceHash: string): EvaluatedExperimentSnapshot {
  return {
    kind: 'experiment',
    sourceHash,
    variables: Object.freeze({}),
    varsSchema: Object.freeze({}),
    scene: Object.freeze({}),
    taskScenes: Object.freeze({}),
    renderScene: Object.freeze({ sceneHash: `${sourceHash}-scene` }),
    taskRenderScenes: Object.freeze({}),
    simulationProgram: Object.freeze({ tasks: Object.freeze({ solve: Object.freeze({}) }) }),
  } as unknown as EvaluatedExperimentSnapshot
}

beforeEach(() => {
  mocks.applyFrozenMaterialParameters.mockReset().mockImplementation((scene) => scene)
  mocks.buildMeasurement.mockReset().mockReturnValue({ materialParameters: {}, taskMaterialParameters: {} })
  mocks.deserializeCadScene.mockReset().mockImplementation((scene) => scene)
  mocks.evaluateDocument.mockReset().mockResolvedValue(evaluatedSnapshot('default'))
  mocks.fetchCatalogRuntimeSlice.mockReset().mockResolvedValue({ catalogRevision: 'test' })
  mocks.inspectDocument.mockReset().mockResolvedValue({ varsSchema: Object.freeze({}) })
  mocks.resolveDocumentMaterials.mockReset().mockResolvedValue({
    materialParameters: Object.freeze({}),
    taskMaterialParameters: Object.freeze({}),
    warnings: Object.freeze([]),
    taskMaterialWarnings: Object.freeze({}),
  })
})

describe('useCadWorkspace lifecycle boundary', () => {
  it('reuses the prepared document when only Candidate vars change', async () => {
    const { result, rerender } = renderHook(
      ({ candidateVars }) => useCadWorkspace(firstExperiment, undefined, { candidateVars }),
      { initialProps: { candidateVars: firstCandidateVars } },
    )

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(1)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(1)
    expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1)

    rerender({ candidateVars: secondCandidateVars })

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(1)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(1)
  })

  it('does not let an aborted source revision overwrite the current result', async () => {
    let resolveFirstEvaluation: (snapshot: EvaluatedExperimentSnapshot) => void = () => undefined
    const firstEvaluation = new Promise<EvaluatedExperimentSnapshot>((resolve) => {
      resolveFirstEvaluation = resolve
    })
    mocks.evaluateDocument
      .mockImplementationOnce(() => firstEvaluation)
      .mockResolvedValueOnce(evaluatedSnapshot('current'))
    const candidateVars = firstCandidateVars
    const { result, rerender } = renderHook(
      ({ experiment }) => useCadWorkspace(experiment, undefined, { candidateVars }),
      { initialProps: { experiment: firstExperiment } },
    )

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    rerender({ experiment: secondExperiment })
    await waitFor(() => expect(result.current.experimentDocument.evaluatedSnapshot?.sourceHash).toBe('current'))

    await act(async () => {
      resolveFirstEvaluation(evaluatedSnapshot('superseded'))
      await firstEvaluation
    })

    expect(result.current.experimentDocument.evaluatedSnapshot?.sourceHash).toBe('current')
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(2)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(2)
  })
})
