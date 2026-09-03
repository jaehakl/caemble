import { useCallback, useMemo, useState, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CalculationDataActions,
  CalculationDataRunSummary,
} from '@/features/calculation/useCalculationDataActions'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CaeDataSelection } from './useCaeDataSelection'
import { useCaeMeasurementActions } from './useCaeMeasurementActions'

const mocks = vi.hoisted(() => ({
  calculateMeasurement: vi.fn(),
  cancelCalculation: vi.fn(),
  create: vi.fn(),
  experimentRecordList: vi.fn(),
  invalidate: vi.fn(),
  loadMeasurement: vi.fn(),
  record: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      ExperimentRecord: { ...actual.dbTables.ExperimentRecord, listRows: mocks.experimentRecordList },
      Measurement: {
        ...actual.dbTables.Measurement,
        create: mocks.create,
        record: mocks.record,
      },
    },
  }
})

vi.mock('@/features/auth/use-auth', () => ({
  usePrivateQueryScope: () => 'user:first',
}))

vi.mock('./queryInvalidation', () => ({
  invalidateMeasurementMutation: mocks.invalidate,
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
  },
}))

const successfulCalculation: CalculationDataRunSummary = Object.freeze({
  total: 1,
  completed: 1,
  succeeded: 1,
  failed: 0,
  cancelled: false,
})

function measurement(id: number): SavedMeasurement {
  return {
    id,
    experiment_id: 10,
    vars: { length: id },
    material_parameters: { experiment: { materials: {} }, tasks: {} },
    recorded_at: null,
    calculation_data_count: 0,
  }
}

function document(overrides: Partial<CadDocumentController> = {}): CadDocumentController {
  return {
    candidateGeneration: 0,
    completedCandidateGeneration: 0,
    compiledSource: null,
    diagnostics: [],
    documentType: 'experiment',
    draftTaskNames: [],
    error: null,
    evaluatedSnapshot: null,
    evaluationTimeoutMs: 10_000,
    generateCandidate: vi.fn(),
    handleAddExperimentFile: vi.fn(),
    handleAddExperimentTask: vi.fn(),
    handleExperimentFileChange: vi.fn(),
    handleRemoveExperimentFile: vi.fn(),
    handleRemoveExperimentTask: vi.fn(),
    handleRenderEnd: vi.fn(),
    handleRenderError: vi.fn(),
    handleRenderStart: vi.fn(),
    handleSimulationCodeChange: vi.fn(),
    handleSourceChange: vi.fn(),
    materialParameters: { experiment: { materials: {} }, tasks: {} },
    materialWarnings: [],
    measurement: null,
    readOnly: false,
    resultSessionKey: null,
    revision: 1,
    runIsBusy: false,
    scene: null,
    sceneHash: null,
    setEvaluationTimeoutMs: vi.fn(),
    simulationProgram: {
      pythonSource: '',
      tasks: {},
      recordedData: { output: { dtype: 'int32', tensorOrder: 0 } },
    },
    sourceReadOnly: false,
    status: 'Ready',
    successfulCandidateGeneration: 0,
    successfulRevision: 1,
    taskSceneHashes: {},
    taskScenes: {},
    validatedRevision: 1,
    variables: { length: 1 },
    varsSchema: null,
    ...overrides,
  }
}

function simulation(overrides: Partial<SimulationController> = {}): SimulationController {
  return {
    canRun: true,
    cancel: vi.fn(),
    process: {
      runId: null,
      status: 'idle',
      engine: null,
      stage: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    },
    recordedData: { output: { shape: [], storage: { kind: 'inline', value: 42 } } },
    run: vi.fn(() => 'run-1'),
    stale: false,
    ...overrides,
  }
}

describe('useCaeMeasurementActions workflows', () => {
  let queryClient: QueryClient
  let rows: Map<number, SavedMeasurement>

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    rows = new Map()
    mocks.calculateMeasurement.mockReset().mockResolvedValue(successfulCalculation)
    mocks.cancelCalculation.mockReset()
    mocks.create.mockReset()
    mocks.experimentRecordList.mockReset().mockResolvedValue({
      items: [
        {
          id: 7,
          experiment_id: 10,
          name: 'output',
          quantity_kind: null,
          tensor_order: 0,
          dtype: 'int32',
          contract_hash: 'output-contract',
        },
      ],
      total: 1,
    })
    mocks.invalidate.mockReset().mockResolvedValue([])
    mocks.loadMeasurement.mockReset().mockImplementation(async (id: number) => rows.get(id) ?? null)
    mocks.record.mockReset().mockResolvedValue(undefined)
  })

  function renderActions({
    initialMeasurement = null,
    initialDocument = document(),
    initialSimulation = simulation(),
    onGenerateCandidate = vi.fn(() => 1),
  }: {
    initialMeasurement?: SavedMeasurement | null
    initialDocument?: CadDocumentController
    initialSimulation?: SimulationController
    onGenerateCandidate?: () => number | null
  } = {}) {
    const calculationDataActions = {
      calculateMeasurement: mocks.calculateMeasurement,
      cancel: mocks.cancelCalculation,
    } as unknown as CalculationDataActions
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    return renderHook(
      ({ experimentDocument, simulationController }) => {
        const [selectedMeasurement, setSelectedMeasurement] = useState(initialMeasurement)
        const clearMeasurement = useCallback(() => setSelectedMeasurement(null), [])
        const loadMeasurement = useCallback(async (id: number) => {
          const row = await mocks.loadMeasurement(id)
          if (row) setSelectedMeasurement(row)
          return row
        }, [])
        const selection = useMemo(
          () =>
            ({
              measurement: selectedMeasurement,
              clearMeasurement,
              loadMeasurement,
            }) as unknown as CaeDataSelection,
          [clearMeasurement, loadMeasurement, selectedMeasurement],
        )
        return {
          ...useCaeMeasurementActions({
            authenticated: true,
            calculationDataActions,
            experimentClean: true,
            experimentDocument,
            experimentId: 10,
            experimentSourceHash: 'source-hash',
            onGenerateCandidate,
            selection,
            simulation: simulationController,
          }),
          clearSelectedMeasurement: clearMeasurement,
          selectedMeasurement,
        }
      },
      {
        initialProps: { experimentDocument: initialDocument, simulationController: initialSimulation },
        wrapper,
      },
    )
  }

  it('completes Save & Run only after Measurement, RecordedData, and CalculationData succeed', async () => {
    const saved = measurement(41)
    rows.set(saved.id, saved)
    mocks.create.mockResolvedValue({ id: saved.id })
    const run = vi.fn(() => 'save-run-1')
    const rendered = renderActions({ initialSimulation: simulation({ run }) })
    await waitFor(() => expect(mocks.experimentRecordList).toHaveBeenCalledOnce())

    let completionPromise!: ReturnType<typeof rendered.result.current.saveAndRunCurrentAsync>
    act(() => {
      completionPromise = rendered.result.current.saveAndRunCurrentAsync()
    })
    await waitFor(() => expect(rendered.result.current.selectedMeasurement?.id).toBe(saved.id))

    rendered.rerender({
      experimentDocument: document({ revision: 2, successfulRevision: 2 }),
      simulationController: simulation({ run }),
    })
    await waitFor(() => expect(run).toHaveBeenCalledOnce())

    rendered.rerender({
      experimentDocument: document({ revision: 2, successfulRevision: 2 }),
      simulationController: simulation({
        run,
        process: {
          runId: 'save-run-1',
          status: 'succeeded',
          engine: { name: 'test', version: '1' },
          stage: '완료',
          error: null,
          startedAt: 1,
          finishedAt: 2,
        },
      }),
    })

    let completion!: Awaited<typeof completionPromise>
    await act(async () => {
      completion = await completionPromise
    })
    expect(completion).toEqual({
      attemptId: 1,
      measurementId: saved.id,
      recordedDataSaved: true,
      calculationSummary: successfulCalculation,
    })
    expect(mocks.record).toHaveBeenCalledWith(saved.id, {
      recorded_data: [{ experiment_record_id: 7, data: { shape: [], storage: { kind: 'inline', value: 42 } } }],
    })
    expect(mocks.calculateMeasurement).toHaveBeenCalledWith(saved.id, expect.any(Object))
    expect(rendered.result.current.operation).toBeNull()
    expect(rendered.result.current.pendingRecordMeasurementId).toBeNull()
  })

  it('cancels an active Save & Run and rejects its completion while preserving the Prepared Measurement', async () => {
    const saved = measurement(42)
    rows.set(saved.id, saved)
    mocks.create.mockResolvedValue({ id: saved.id })
    const cancelSimulation = vi.fn()
    const run = vi.fn(() => 'save-run-2')
    const rendered = renderActions({ initialSimulation: simulation({ cancel: cancelSimulation, run }) })

    let completionPromise!: ReturnType<typeof rendered.result.current.saveAndRunCurrentAsync>
    act(() => {
      completionPromise = rendered.result.current.saveAndRunCurrentAsync()
    })
    const rejection = completionPromise.catch((cause: unknown) => cause)
    await waitFor(() => expect(rendered.result.current.selectedMeasurement?.id).toBe(saved.id))
    rendered.rerender({
      experimentDocument: document({ revision: 2, successfulRevision: 2 }),
      simulationController: simulation({ cancel: cancelSimulation, run }),
    })
    await waitFor(() => expect(rendered.result.current.cancelable).toBe(true))

    act(() => rendered.result.current.cancel())

    expect(await rejection).toEqual(
      expect.objectContaining({ message: expect.stringContaining('Prepared Measurement #42') }),
    )
    expect(cancelSimulation).toHaveBeenCalledOnce()
    expect(rendered.result.current.selectedMeasurement?.id).toBe(saved.id)
    expect(rendered.result.current.operation).toBeNull()
    expect(mocks.record).not.toHaveBeenCalled()
  })

  it('keeps the failed RecordedData request and retries it before automatic CalculationData', async () => {
    const saved = measurement(51)
    rows.set(saved.id, saved)
    mocks.record.mockRejectedValueOnce(new Error('record unavailable')).mockResolvedValueOnce(undefined)
    const run = vi.fn(() => 'measurement-run')
    const rendered = renderActions({ initialMeasurement: saved, initialSimulation: simulation({ run }) })
    await waitFor(() => expect(mocks.experimentRecordList).toHaveBeenCalledOnce())

    act(() => {
      expect(rendered.result.current.runSelected()).toBe('measurement-run')
    })
    rendered.rerender({
      experimentDocument: document(),
      simulationController: simulation({
        run,
        process: {
          runId: 'measurement-run',
          status: 'succeeded',
          engine: { name: 'test', version: '1' },
          stage: '완료',
          error: null,
          startedAt: 1,
          finishedAt: 2,
        },
      }),
    })
    await waitFor(() => expect(rendered.result.current.pendingRecordMeasurementId).toBe(saved.id))
    expect(mocks.calculateMeasurement).not.toHaveBeenCalled()

    let retried = false
    await act(async () => {
      retried = await rendered.result.current.retryRecord()
    })

    expect(retried).toBe(true)
    expect(mocks.record).toHaveBeenCalledTimes(2)
    expect(mocks.calculateMeasurement).toHaveBeenCalledWith(saved.id, expect.any(Object))
    expect(rendered.result.current.pendingRecordMeasurementId).toBeNull()
    expect(rendered.result.current.error).toBeNull()
    expect(rendered.result.current.operation).toBeNull()
  })

  it('runs every Repeat Run attempt sequentially and reports the accumulated result', async () => {
    const first = measurement(61)
    const second = measurement(62)
    rows.set(first.id, first)
    rows.set(second.id, second)
    mocks.create.mockResolvedValueOnce({ id: first.id }).mockResolvedValueOnce({ id: second.id })
    const generate = vi.fn().mockReturnValueOnce(1).mockReturnValueOnce(2)
    const run = vi.fn().mockReturnValueOnce('repeat-1').mockReturnValueOnce('repeat-2')
    const rendered = renderActions({ initialSimulation: simulation({ run }), onGenerateCandidate: generate })
    await waitFor(() => expect(mocks.experimentRecordList).toHaveBeenCalledOnce())

    act(() => {
      expect(rendered.result.current.repeatGenerateAndRun(2)).toBe(true)
    })
    expect(rendered.result.current.generateAndRunBatch).toMatchObject({ attempt: 1, total: 2, repeat: true })

    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 1,
        revision: 2,
        successfulCandidateGeneration: 1,
        successfulRevision: 2,
      }),
      simulationController: simulation({ run }),
    })
    await waitFor(() => expect(rendered.result.current.selectedMeasurement?.id).toBe(first.id))
    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 1,
        revision: 3,
        successfulCandidateGeneration: 1,
        successfulRevision: 3,
      }),
      simulationController: simulation({ run }),
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 1,
        revision: 3,
        successfulCandidateGeneration: 1,
        successfulRevision: 3,
      }),
      simulationController: simulation({
        run,
        process: {
          runId: 'repeat-1',
          status: 'succeeded',
          engine: { name: 'test', version: '1' },
          stage: '완료',
          error: null,
          startedAt: 1,
          finishedAt: 2,
        },
      }),
    })
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2))
    expect(rendered.result.current.generateAndRunBatch).toMatchObject({
      attempt: 2,
      successes: 1,
      failures: 0,
    })

    act(() => rendered.result.current.clearSelectedMeasurement())
    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 2,
        revision: 4,
        successfulCandidateGeneration: 2,
        successfulRevision: 4,
      }),
      simulationController: simulation({ run }),
    })
    await waitFor(() => expect(rendered.result.current.selectedMeasurement?.id).toBe(second.id))
    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 2,
        revision: 5,
        successfulCandidateGeneration: 2,
        successfulRevision: 5,
      }),
      simulationController: simulation({ run }),
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    rendered.rerender({
      experimentDocument: document({
        completedCandidateGeneration: 2,
        revision: 5,
        successfulCandidateGeneration: 2,
        successfulRevision: 5,
      }),
      simulationController: simulation({
        run,
        process: {
          runId: 'repeat-2',
          status: 'succeeded',
          engine: { name: 'test', version: '1' },
          stage: '완료',
          error: null,
          startedAt: 3,
          finishedAt: 4,
        },
      }),
    })

    await waitFor(() => expect(rendered.result.current.operation).toBeNull())
    expect(rendered.result.current.generateAndRunBatch).toBeNull()
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.record).toHaveBeenCalledTimes(2)
    expect(mocks.calculateMeasurement).toHaveBeenCalledTimes(2)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Repeat Run 2회 완료: 성공 2회, 실패 0회')
  })
})
