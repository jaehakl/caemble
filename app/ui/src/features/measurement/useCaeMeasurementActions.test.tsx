import { useCallback, useState, type PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeBatch, CaeEvent } from '@/contracts/api/cae'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { CalculationDataActions } from '@/features/calculation/useCalculationDataActions'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import type { CaeDataSelection } from './useCaeDataSelection'
import { ApiError } from '@/api/http'
import { useCaeMeasurementActions } from './useCaeMeasurementActions'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
  wait: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  calculate: vi.fn(),
  cancelCalculation: vi.fn(),
  invalidate: vi.fn(),
  update: vi.fn(),
  inspect: vi.fn(),
  load: vi.fn(),
  generate: vi.fn(),
  batches: [] as CaeBatch[],
  events: [] as CaeEvent[],
}))
vi.mock('./buildBatchArtifact', () => ({
  buildBatchArtifact: async (request: unknown) => ({ artifact: request, store: { readItem: vi.fn(), close: vi.fn() } }),
}))
vi.mock('@/api/submitArtifact', () => ({
  submitArtifact: async (options: { artifact: unknown; onRegistered: (id: string) => Promise<void> }) => {
    const result = await mocks.create(options.artifact)
    await options.onRegistered(result.id)
    return result
  },
}))
vi.mock('@/api/cae', () => ({ caeBatches: { create: mocks.create, read: mocks.read, cancel: mocks.cancel } }))
vi.mock('@/api', () => ({ dbTables: { Measurement: { create: mocks.save } } }))
vi.mock('@/features/cae/CaeBatchProvider', () => ({
  useCaeBatches: () => ({
    batches: mocks.batches,
    events: mocks.events,
    update: mocks.update,
    readPage: mocks.read,
    waitForChange: mocks.wait,
    inspectBatch: mocks.inspect,
  }),
}))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'user:first' }))
vi.mock('./queryInvalidation', () => ({ invalidateMeasurementMutation: mocks.invalidate }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

const materialSnapshot = {
  sourceHash: 'source',
  varsHash: 'vars',
  modelDefinitions: [],
  selections: {},
  experiment: { materials: {} },
  tasks: { solve: { materials: {} } },
}
const document = {
  draftTaskNames: [],
  revision: 2,
  successfulRevision: 2,
  status: 'Ready',
  runIsBusy: false,
  variables: { length: 42 },
  materialSnapshot,
  evaluationTimeoutMs: 10_000,
} as unknown as CadDocumentController
const summary = { total: 1, completed: 1, succeeded: 1, failed: 0, cancelled: false }

function batch(ids: readonly number[] = [41]): CaeBatch {
  return {
    id: 'batch-1',
    experiment_id: 10,
    mode: 'candidate',
    total: ids.length,
    uploaded_count: 0,
    created_count: ids.length,
    succeeded: ids.length,
    failed: 0,
    cancelled: 0,
    state: 'completed',
    created_at: '2026-09-07T00:00:00Z',
    updated_at: '2026-09-07T00:00:01Z',
    finished_at: '2026-09-07T00:00:01Z',
    last_event_id: 5,
    read_event_id: 0,
    jobs_total: ids.length,
    jobs: ids.map((id, index) => ({
      id: `job-${id}`,
      index,
      attempt_count: 1,
      state: 'succeeded',
      measurement_id: id,
      progress: null,
      last_error: null,
      created_at: '',
      updated_at: '',
    })),
  }
}
function measurement(id: number): SavedMeasurement {
  return {
    id,
    experiment_id: 10,
    vars: { length: 42 },
    material_snapshot: materialSnapshot,
    recorded_at: null,
    calculation_data_count: 0,
  }
}
function renderActions(selected: SavedMeasurement | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return renderHook(
    ({ sourceHash }) => {
      const [row, setRow] = useState(selected)
      const loadMeasurement = useCallback(async (id: number) => {
        mocks.load(id)
        const next = measurement(id)
        setRow(next)
        return next
      }, [])
      const selection = {
        measurement: row,
        loadMeasurement,
        clearMeasurement: () => setRow(null),
      } as unknown as CaeDataSelection
      return useCaeMeasurementActions({
        authenticated: true,
        calculationDataActions: {
          calculateMeasurement: mocks.calculate,
          cancel: mocks.cancelCalculation,
        } as unknown as CalculationDataActions,
        experimentClean: true,
        experimentDocument: document,
        experimentId: 10,
        experimentSourceHash: sourceHash,
        onGenerateCandidate: mocks.generate,
        selection,
      })
    },
    { initialProps: { sourceHash: 'source-hash' }, wrapper },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.update.mockImplementation((value: CaeBatch) => value)
  mocks.wait.mockImplementation(
    (_id: string, _previous: CaeBatch, signal: AbortSignal) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  )
  mocks.events = []
  mocks.batches = []
  mocks.create.mockResolvedValue(batch())
  mocks.read.mockResolvedValue(batch())
  mocks.cancel.mockResolvedValue({ ...batch(), state: 'cancelled' })
  mocks.calculate.mockResolvedValue(summary)
  mocks.invalidate.mockResolvedValue([])
})

describe('server-owned CAE measurement actions', () => {
  it('submits one multi-Candidate batch and continues after Calculation failures across result pages', async () => {
    const completed = batch(Array.from({ length: 102 }, (_, index) => index + 1))
    mocks.create.mockResolvedValue({ ...completed, jobs: completed.jobs.slice(0, 100) })
    mocks.read.mockResolvedValue({ ...completed, jobs: completed.jobs.slice(100) })
    mocks.calculate.mockRejectedValueOnce(new Error('Calculation failed'))
    const rendered = renderActions()
    const progress = vi.fn()
    await act(async () => {
      const result = await rendered.result.current.runCandidatesAsync(
        { count: 102, next: async () => ({ x: 1 }), accepted: vi.fn(), failed: vi.fn() },
        progress,
      )
      expect(result).toMatchObject({ total: 102, succeeded: 102, calculated: 102, calculationFailed: 1 })
    })
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'candidate', candidates: expect.objectContaining({ count: 102 }) }),
    )
    expect(mocks.calculate).toHaveBeenCalledTimes(102)
    expect(new Set(mocks.calculate.mock.calls.map(([id]) => id)).size).toBe(102)
    expect(mocks.read).toHaveBeenCalledWith('batch-1', { offset: 100, limit: 100 })
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('returns a batch summary even when all server jobs fail', async () => {
    mocks.create.mockResolvedValue({
      ...batch([41, 42]),
      succeeded: 0,
      failed: 2,
      jobs: batch([41, 42]).jobs.map((job) => ({ ...job, state: 'failed' })),
    })
    const rendered = renderActions()
    await act(async () => {
      expect(
        await rendered.result.current.runCandidatesAsync(
          { count: 2, next: async () => ({ x: 1 }), accepted: vi.fn(), failed: vi.fn() },
          vi.fn(),
        ),
      ).toMatchObject({ succeeded: 0, failed: 2, calculated: 0 })
    })
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'source-change'] as const)('handles %s while a Candidate Batch is running', async (action) => {
    mocks.create.mockResolvedValue({ ...batch(), state: 'running', finished_at: null, succeeded: 0, jobs: [] })
    const rendered = renderActions()
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current
        .runCandidatesAsync({ count: 3, next: async () => ({ x: 1 }), accepted: vi.fn(), failed: vi.fn() }, vi.fn())
        .catch((cause: unknown) => cause)
    })
    await waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce())
    if (action === 'cancel') act(() => rendered.result.current.cancel())
    else rendered.rerender({ sourceHash: 'changed-source' })
    await act(async () => {
      expect(await completion).toMatchObject({ name: 'AbortError' })
    })
    if (action === 'cancel') expect(mocks.cancel).toHaveBeenCalledWith('batch-1')
    else expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.calculate).not.toHaveBeenCalled()
  })
  it('waits for shared events without polling and postprocesses each completion only once', async () => {
    const initial = {
      ...batch(),
      state: 'running' as const,
      finished_at: null,
      succeeded: 0,
      jobs: batch().jobs.map((job) => ({ ...job, state: 'running' })),
    }
    mocks.create.mockResolvedValue(initial)
    let changed!: (value: CaeBatch) => void
    mocks.wait.mockImplementation(
      () =>
        new Promise<CaeBatch>((resolve) => {
          changed = resolve
        }),
    )
    const rendered = renderActions()
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current.saveAndRunCurrentAsync()
    })
    await waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce())
    vi.useFakeTimers()
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000)
      })
    } finally {
      vi.useRealTimers()
    }
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.calculate).not.toHaveBeenCalled()
    await act(async () => {
      changed({ ...batch(), state: 'running', finished_at: null })
    })
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledOnce())
    await act(async () => {
      changed(batch())
      await completion
    })
    expect(mocks.calculate).toHaveBeenCalledOnce()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('submits the fixed Candidate and material snapshot and awaits browser CalculationData', async () => {
    let finishCalculation!: (value: typeof summary) => void
    mocks.calculate.mockReturnValue(
      new Promise((resolve) => {
        finishCalculation = resolve
      }),
    )
    const rendered = renderActions()
    let completion!: ReturnType<typeof rendered.result.current.saveAndRunCurrentAsync>
    act(() => {
      completion = rendered.result.current.saveAndRunCurrentAsync()
    })
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledWith(41, expect.any(Object)))
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'candidate',
        vars: { length: 42 },
        material_snapshot: materialSnapshot,
        experiment_source_hash: 'source-hash',
      }),
    )
    expect(mocks.save).not.toHaveBeenCalled()
    expect(rendered.result.current.busy).toBe(true)
    await act(async () => {
      finishCalculation(summary)
      expect(await completion).toMatchObject({
        measurementId: 41,
        recordedDataSaved: true,
        calculationSummary: summary,
      })
    })
    expect(rendered.result.current.busy).toBe(false)
  })

  it('submits Repeat Run once and processes foreground postprocessing sequentially', async () => {
    mocks.create.mockResolvedValue({ ...batch([41, 42]), mode: 'generate' })
    let finishFirst!: (value: typeof summary) => void
    mocks.calculate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        }),
    )
    const rendered = renderActions()
    act(() => {
      rendered.result.current.repeatGenerateAndRun(2)
    })
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(1))
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'generate', count: 2 }))
    expect(mocks.generate).not.toHaveBeenCalled()
    await act(async () => finishFirst(summary))
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(2))
    expect(mocks.calculate.mock.calls.map(([id]) => id)).toEqual([41, 42])
  })

  it('keeps the accepted job running after the observer unmounts', async () => {
    let accept!: (value: CaeBatch) => void
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      }),
    )
    const rendered = renderActions()
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current.saveAndRunCurrentAsync().catch((cause: unknown) => cause)
    })
    rendered.unmount()
    accept(batch())
    expect(await completion).toMatchObject({ name: 'AbortError' })
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it('detaches on source change without cancelling the server job', async () => {
    let accept!: (value: CaeBatch) => void
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      }),
    )
    const rendered = renderActions()
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current.saveAndRunCurrentAsync().catch((cause: unknown) => cause)
    })
    rendered.rerender({ sourceHash: 'new-source-hash' })
    await act(async () => {
      accept(batch())
      await completion
    })
    expect(mocks.cancel).not.toHaveBeenCalled()
    expect(rendered.result.current.busy).toBe(false)
  })

  it('delivers an explicit cancellation even when registration is still in flight', async () => {
    let accept!: (value: CaeBatch) => void
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve
      }),
    )
    const rendered = renderActions()
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current.saveAndRunCurrentAsync().catch((cause: unknown) => cause)
    })
    act(() => rendered.result.current.cancel())
    await act(async () => {
      accept(batch())
      await completion
    })
    expect(mocks.cancel).toHaveBeenCalledWith('batch-1')
  })

  it('reloads the selected Measurement after an event and never selects unrelated results', async () => {
    const rendered = renderActions(measurement(41))
    mocks.events = [
      { id: 10, type: 'job.succeeded', batch_id: 'another-batch', measurement_id: 42, payload: {}, created_at: '' },
    ]
    rendered.rerender({ sourceHash: 'source-hash' })
    expect(mocks.load).not.toHaveBeenCalled()
    mocks.events = [
      ...mocks.events,
      { id: 11, type: 'job.succeeded', batch_id: 'batch-1', measurement_id: 41, payload: {}, created_at: '' },
    ]
    rendered.rerender({ sourceHash: 'source-hash' })
    await waitFor(() => expect(mocks.load).toHaveBeenCalledWith(41))
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it('uses the saved Measurement ID for Prepared Run without creating another Measurement', async () => {
    const rendered = renderActions(measurement(41))
    act(() => {
      expect(rendered.result.current.runSelected()).toEqual(expect.any(String))
    })
    await waitFor(() => expect(rendered.result.current.busy).toBe(false))
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'measurement', measurement_id: 41 }))
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('opens the existing batch for a linked Prepared Measurement instead of registering it again', () => {
    mocks.batches = [
      {
        ...batch(),
        state: 'completed',
        succeeded: 0,
        failed: 1,
        jobs: batch().jobs.map((job) => ({ ...job, state: 'failed' })),
      },
    ]
    const rendered = renderActions(measurement(41))
    act(() => {
      expect(rendered.result.current.runSelected()).toBeNull()
    })
    expect(mocks.inspect).toHaveBeenCalledWith('batch-1')
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('opens a linked job outside the snapshot page when registration returns its batch', async () => {
    mocks.create.mockRejectedValue(
      new ApiError(409, 'Already linked', { detail: { batch_id: 'batch-1', job_id: 'job-41' } }),
    )
    const rendered = renderActions(measurement(41))
    act(() => {
      rendered.result.current.runSelected()
    })
    await waitFor(() => expect(mocks.inspect).toHaveBeenCalledWith('batch-1'))
    expect(mocks.read).toHaveBeenCalledWith('batch-1')
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it('visits every paginated result of a large batch exactly once', async () => {
    const completed = { ...batch(Array.from({ length: 153 }, (_, index) => index + 1)), mode: 'generate' as const }
    mocks.create.mockResolvedValue({ ...completed, jobs: completed.jobs.slice(0, 50) })
    mocks.read.mockImplementation(async (_id: string, { offset, limit }: { offset: number; limit: number }) => ({
      ...completed,
      jobs: completed.jobs.slice(offset, offset + limit),
    }))
    const rendered = renderActions()
    act(() => {
      rendered.result.current.repeatGenerateAndRun(153)
    })
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(153))
    expect(mocks.read.mock.calls.map(([, page]) => page)).toEqual([
      { offset: 50, limit: 100 },
      { offset: 150, limit: 100 },
    ])
    expect(mocks.calculate.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 153 }, (_, index) => index + 1))
    expect(mocks.create).toHaveBeenCalledOnce()
  })

  it('reports a server-side cancellation as AbortError so Prediction stops its local loop', async () => {
    mocks.create.mockResolvedValue({
      ...batch(),
      state: 'cancelled',
      succeeded: 0,
      cancelled: 1,
      uploaded_count: 0,
      created_count: 0,
      jobs_total: 0,
      jobs: [],
    })
    const rendered = renderActions()
    await act(async () => {
      await expect(rendered.result.current.saveAndRunCurrentAsync()).rejects.toMatchObject({ name: 'AbortError' })
    })
    expect(mocks.calculate).not.toHaveBeenCalled()
  })
})
