import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluatedExperimentSnapshot } from '@/lib/cad/execution'
import type { ExperimentSourceDocument } from '@/lib/cad/source'
import { useCadWorkspace } from './useCadWorkspace'
import { emitRuntimeActivity } from '@/features/runtime-console/types'
import { CadCompilationError } from '@/lib/cad/compiler/monacoCompiler'

const mocks = vi.hoisted(() => ({
  applyMaterialSnapshot: vi.fn(),
  buildMeasurement: vi.fn(),
  deserializeCadScene: vi.fn(),
  evaluateDocument: vi.fn(),
  preparePredictionDocument: vi.fn(),
  fetchCatalogRuntimeSlice: vi.fn(),
  inspectDocument: vi.fn(),
  resolveDocumentMaterials: vi.fn(),
}))

vi.mock('@/features/runtime-console/types', () => ({ emitRuntimeActivity: vi.fn() }))

vi.mock('@/lib/cad/compiler/monacoCompiler', () => {
  class CadCompilationError extends Error {}
  return { CadCompilationError }
})

vi.mock('@/lib/cad/execution/evaluateDocument', () => ({ preparePredictionDocument: mocks.preparePredictionDocument }))

vi.mock('@/lib/cad/execution', () => {
  class CadDocumentEvaluationError extends Error {}
  return {
    applyMaterialSnapshot: mocks.applyMaterialSnapshot,
    buildMeasurement: mocks.buildMeasurement,
    CadDocumentEvaluationError,
    deserializeCadScene: mocks.deserializeCadScene,
    evaluateDocument: mocks.evaluateDocument,
    inspectDocument: mocks.inspectDocument,
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
  vi.mocked(emitRuntimeActivity).mockClear()
  mocks.preparePredictionDocument.mockReset().mockImplementation(async ({ vars }, records) => ({
    sourceHash: 'source',
    variables: vars,
    varsSchema: {},
    records,
    geometrySources: ['experiment'],
    simulationProgram: { tasks: {}, recordedData: {}, resultContracts: {}, boxGrids: {} },
  }))
  mocks.applyMaterialSnapshot.mockReset().mockImplementation((scene) => scene)
  mocks.buildMeasurement.mockReset().mockImplementation((snapshot, resolution) => ({
    experiment: snapshot,
    ...resolution,
    varsHash: 'vars',
    modelDefinitions: [],
    materialSelections: {},
  }))
  mocks.deserializeCadScene.mockReset().mockImplementation((scene) => scene)
  mocks.evaluateDocument.mockReset().mockResolvedValue(evaluatedSnapshot('default'))
  mocks.fetchCatalogRuntimeSlice.mockReset().mockResolvedValue({ catalogRevision: 'test' })
  mocks.inspectDocument.mockReset().mockResolvedValue({ varsSchema: Object.freeze({}) })
  mocks.resolveDocumentMaterials.mockReset().mockResolvedValue({
    materialSnapshot: Object.freeze({}),
    taskMaterialSnapshots: Object.freeze({}),
    warnings: Object.freeze([]),
    taskMaterialWarnings: Object.freeze({}),
  })
})

it('initializes Prediction Vars and all output contracts before selecting any BoxGrid', async () => {
  const schema = { x: { dtype: 'float64', shape: [], min: 0, max: 2 } }
  const contracts = { 'heat.T': { task: 'heat', output: 'T' } }
  mocks.inspectDocument.mockResolvedValue({ varsSchema: schema })
  mocks.preparePredictionDocument.mockImplementation(async ({ vars }, records) => ({
    sourceHash: 'source',
    variables: vars,
    varsSchema: schema,
    records,
    geometrySources: [],
    simulationProgram: {
      tasks: {},
      recordedData: {},
      resultContracts: contracts,
      boxGrids: records.length ? { 'heat.T': { ready: true } } : {},
    },
  }))
  const { result, rerender } = renderHook(
    ({ records }) =>
      useCadWorkspace(firstExperiment, undefined, {
        candidateVars: firstCandidateVars,
        predictionRecords: records,
        geometryRequired: false,
      }),
    { initialProps: { records: [] as readonly string[] } },
  )
  await waitFor(() => expect(result.current.experimentDocument.variables).toEqual(firstCandidateVars))
  expect(result.current.experimentDocument.varsSchema).toEqual(schema)
  expect(result.current.experimentDocument.simulationProgram?.resultContracts).toEqual(contracts)
  expect(result.current.experimentDocument.simulationProgram?.boxGrids).toEqual({})
  rerender({ records: ['heat.T'] })
  await waitFor(() => expect(result.current.experimentDocument.predictionCandidate?.records).toEqual(['heat.T']))
  expect(mocks.inspectDocument).toHaveBeenCalledOnce()
  expect(mocks.evaluateDocument).not.toHaveBeenCalled()
  expect(mocks.buildMeasurement).not.toHaveBeenCalled()
})

it('reports source errors once per location with technical details and keeps editor diagnostics', async () => {
  const diagnostic = {
    file: 'experiment.tsx',
    message: 'Unknown material',
    severity: 'error',
    code: 1,
    phase: 'semantic',
    range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 8 },
  }
  const cause = Object.assign(new Error('Compilation failed'), {
    diagnostics: [diagnostic, { ...diagnostic }],
    errorType: 'type',
  })
  Object.setPrototypeOf(cause, CadCompilationError.prototype)
  mocks.inspectDocument.mockRejectedValue(cause)
  const { result, rerender } = renderHook(() => useCadWorkspace(firstExperiment, undefined))
  await waitFor(() => expect(result.current.experimentDocument.status).toBe('Error'))
  const errors = vi
    .mocked(emitRuntimeActivity)
    .mock.calls.map(([, event]) => event)
    .filter((event) => event.level === 'error')
  expect(errors).toHaveLength(1)
  expect(errors[0]).toMatchObject({
    message: 'Unknown material',
    details: {
      title: 'Type Error',
      file: 'experiment.tsx',
      line: 2,
      column: 3,
      stack: expect.any(String),
    },
  })
  expect(result.current.experimentDocument.diagnostics).toHaveLength(2)
  rerender()
  expect(vi.mocked(emitRuntimeActivity).mock.calls.filter(([, event]) => event.level === 'error')).toHaveLength(1)
})

describe('useCadWorkspace lifecycle boundary', () => {
  it.each(['source', 'session'] as const)('hides the previous varsSchema during a %s change', async (change) => {
    const schema = Object.freeze({ sizeX: { shape: [], min: 1, max: 10 } })
    const observations: (typeof schema | null)[] = []
    mocks.inspectDocument.mockResolvedValue({ varsSchema: schema })
    mocks.evaluateDocument.mockResolvedValue({ ...evaluatedSnapshot('first'), varsSchema: schema })
    const { result, rerender } = renderHook(
      ({ experiment, resetKey }) => {
        const workspace = useCadWorkspace(experiment, undefined, { resetKey })
        observations.push(workspace.experimentDocument.varsSchema as typeof schema | null)
        return workspace
      },
      { initialProps: { experiment: firstExperiment, resetKey: 1 } },
    )
    await waitFor(() => expect(result.current.experimentDocument.varsSchema).toEqual(schema))
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    mocks.inspectDocument.mockImplementation(() => new Promise(() => undefined))
    observations.length = 0

    rerender({
      experiment: change === 'source' ? secondExperiment : firstExperiment,
      resetKey: change === 'session' ? 2 : 1,
    })

    // Check every render, including the render before passive effects clear old state.
    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every((value) => value === null)).toBe(true)
    expect(result.current.experimentDocument.varsSchema).toBeNull()
  })

  it('evaluates the Candidate restored with a new workspace session without regenerating it', async () => {
    mocks.evaluateDocument.mockImplementation(async ({ vars }) => ({
      ...evaluatedSnapshot('restored'),
      variables: vars,
    }))
    const { result, rerender } = renderHook(
      ({ experiment, candidateVars, resetKey }) => useCadWorkspace(experiment, undefined, { candidateVars, resetKey }),
      { initialProps: { experiment: firstExperiment, candidateVars: firstCandidateVars, resetKey: 1 } },
    )
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    await waitFor(() => expect(result.current.experimentDocument.variables).toEqual(firstCandidateVars))

    rerender({ experiment: secondExperiment, candidateVars: secondCandidateVars, resetKey: 2 })

    await waitFor(() => expect(result.current.experimentDocument.resultSessionKey).toBe(2))
    expect(mocks.evaluateDocument).toHaveBeenLastCalledWith(
      { document: secondExperiment, vars: secondCandidateVars },
      expect.anything(),
    )
    expect(result.current.experimentDocument.variables).toEqual(secondCandidateVars)
  })

  it('retains the saved material snapshot supplied with a restored Measurement session', async () => {
    const materialSnapshot = {
      experiment: { materials: {} },
      tasks: {},
      sourceHash: 'saved-source',
      varsHash: 'saved-vars',
      modelDefinitions: [],
      selections: {},
    }
    const { result, rerender } = renderHook(
      ({ resetKey }) =>
        useCadWorkspace(firstExperiment, undefined, {
          resetKey,
          candidateVars: firstCandidateVars,
          candidateProvenance: 'persisted-measurement',
          persistedMaterialSnapshot: materialSnapshot,
        }),
      { initialProps: { resetKey: 1 } },
    )
    await waitFor(() => expect(result.current.experimentDocument.resultSessionKey).toBe(1))

    rerender({ resetKey: 2 })

    await waitFor(() => expect(result.current.experimentDocument.resultSessionKey).toBe(2))
    expect(mocks.resolveDocumentMaterials).toHaveBeenLastCalledWith(
      expect.anything(),
      materialSnapshot,
      expect.anything(),
    )
  })

  it('waits for the requested Measurement instead of evaluating the retained draft Candidate', async () => {
    const { result, rerender } = renderHook(
      ({ pending, candidateVars }) =>
        useCadWorkspace(firstExperiment, undefined, {
          candidateVars,
          candidateVarsPending: pending,
          candidateProvenance: 'persisted-measurement',
        }),
      { initialProps: { pending: true, candidateVars: firstCandidateVars } },
    )
    await waitFor(() => expect(result.current.experimentDocument.varsSchema).not.toBeNull())
    expect(mocks.evaluateDocument).not.toHaveBeenCalled()

    rerender({ pending: false, candidateVars: secondCandidateVars })

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    expect(mocks.evaluateDocument).toHaveBeenLastCalledWith(
      { document: firstExperiment, vars: secondCandidateVars },
      expect.anything(),
    )
  })

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

it('stops measurement construction when material resolution fails', async () => {
  mocks.resolveDocumentMaterials.mockRejectedValue(new Error('Material resolution failed'))
  const { result } = renderHook(() =>
    useCadWorkspace(firstExperiment, undefined, { candidateVars: firstCandidateVars }),
  )
  await waitFor(() => expect(result.current.experimentDocument.status).toBe('Error'))
  expect(result.current.experimentDocument.error?.message).toContain('Material resolution failed')
  expect(mocks.buildMeasurement).not.toHaveBeenCalled()
  expect(result.current.experimentDocument.measurement).toBeNull()
})

describe('prediction preparation without Geometry', () => {
  it('rejects an execution callback captured before the Candidate changed', async () => {
    const { result, rerender } = renderHook(
      ({ vars }) =>
        useCadWorkspace(firstExperiment, undefined, {
          candidateVars: vars,
          predictionRecords: [],
        }),
      { initialProps: { vars: firstCandidateVars } },
    )
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(firstCandidateVars),
    )
    const previous = result.current.experimentDocument.ensureFullEvaluation!
    rerender({ vars: secondCandidateVars })
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(secondCandidateVars),
    )
    await expect(previous()).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.evaluateDocument).not.toHaveBeenCalled()
  })
  it('skips full evaluation, material resolution and mesh deserialization across Vars changes, and reuses metadata', async () => {
    const { result, rerender } = renderHook(
      ({ vars }) =>
        useCadWorkspace(firstExperiment, undefined, {
          candidateVars: vars,
          predictionRecords: [],
          geometryRequired: false,
        }),
      { initialProps: { vars: firstCandidateVars } },
    )
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(firstCandidateVars),
    )
    rerender({ vars: secondCandidateVars })
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(secondCandidateVars),
    )
    rerender({ vars: firstCandidateVars })
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(firstCandidateVars),
    )
    expect(mocks.preparePredictionDocument).toHaveBeenCalledTimes(2)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(1)
    expect(mocks.evaluateDocument).not.toHaveBeenCalled()
    expect(mocks.resolveDocumentMaterials).not.toHaveBeenCalled()
    expect(mocks.buildMeasurement).not.toHaveBeenCalled()
    expect(mocks.deserializeCadScene).not.toHaveBeenCalled()
    expect(result.current.experimentDocument.evaluatedSnapshot).toBeNull()
    expect(result.current.experimentDocument.validatedRevision).toBe(-1)
  })

  it('prepares the latest geometry only when requested and reuses it when toggled again', async () => {
    mocks.evaluateDocument.mockImplementation(async ({ vars }) => ({ ...evaluatedSnapshot('source'), variables: vars }))
    const { result, rerender } = renderHook(
      ({ vars, visible }) =>
        useCadWorkspace(firstExperiment, undefined, {
          candidateVars: vars,
          predictionRecords: [],
          geometryRequired: visible,
        }),
      { initialProps: { vars: firstCandidateVars, visible: false } },
    )
    await waitFor(() => expect(result.current.experimentDocument.predictionCandidate).not.toBeNull())
    rerender({ vars: secondCandidateVars, visible: false })
    await waitFor(() =>
      expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(secondCandidateVars),
    )
    rerender({ vars: secondCandidateVars, visible: true })
    await waitFor(() =>
      expect(result.current.experimentDocument.evaluatedSnapshot?.variables).toEqual(secondCandidateVars),
    )
    rerender({ vars: secondCandidateVars, visible: false })
    rerender({ vars: secondCandidateVars, visible: true })
    expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1)
    expect(mocks.preparePredictionDocument).toHaveBeenCalledTimes(2)
  })

  it('prepares an executable candidate on demand even while Geometry is hidden', async () => {
    mocks.evaluateDocument.mockImplementation(async ({ vars }) => ({ ...evaluatedSnapshot('source'), variables: vars }))
    const { result } = renderHook(() =>
      useCadWorkspace(firstExperiment, undefined, {
        candidateVars: firstCandidateVars,
        predictionRecords: [],
      }),
    )
    await waitFor(() => expect(result.current.experimentDocument.predictionCandidate).not.toBeNull())
    await act(async () => {
      const prepared = await result.current.experimentDocument.ensureFullEvaluation!()
      expect(prepared.variables).toEqual(firstCandidateVars)
      expect(prepared.materialSnapshot).toBeTruthy()
    })
    expect(mocks.buildMeasurement).toHaveBeenCalledTimes(1)
    expect(mocks.preparePredictionDocument).toHaveBeenCalledTimes(1)
  })

  it('cancels hidden geometry work and rejects a late result without invalidating prediction inputs', async () => {
    let resolve!: (value: EvaluatedExperimentSnapshot) => void
    mocks.evaluateDocument.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { result, rerender } = renderHook(
      ({ visible }) =>
        useCadWorkspace(firstExperiment, undefined, {
          candidateVars: firstCandidateVars,
          predictionRecords: [],
          geometryRequired: visible,
        }),
      { initialProps: { visible: true } },
    )
    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    const signal = mocks.evaluateDocument.mock.calls[0][1].signal as AbortSignal
    rerender({ visible: false })
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(evaluatedSnapshot('late')))
    expect(result.current.experimentDocument.evaluatedSnapshot).toBeNull()
    expect(result.current.experimentDocument.predictionCandidate?.variables).toEqual(firstCandidateVars)
  })
})
