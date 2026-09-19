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
  execution: vi.fn(),
  retry: vi.fn(),
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
vi.mock('@/api/cae', () => ({
  caeBatches: {
    create: mocks.create,
    read: mocks.read,
    cancel: mocks.cancel,
    execution: mocks.execution,
    retry: mocks.retry,
  },
}))
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
  varsSchema: { length: { shape: [], min: 10, max: 50 }, tensor: { shape: [2], min: 2, max: 2 } },
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
function renderActions(selected: SavedMeasurement | null = null, candidateDocument = document) {
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
        experimentDocument: candidateDocument,
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
  mocks.execution.mockImplementation(async (id: number) => ({
    measurement_id: id,
    experiment_id: 10,
    recorded_at: null,
    batch_id: null,
    job: null,
  }))
  mocks.retry.mockResolvedValue(batch())
  mocks.calculate.mockResolvedValue(summary)
  mocks.invalidate.mockResolvedValue([])
})

describe('server-owned CAE measurement actions', () => {
  it('notifies recorded data once after invalidation and before a delayed Calculation', async () => {
    let finish: (value: typeof summary) => void = () => {}
    mocks.calculate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const rendered = renderActions()
    const recorded = vi.fn(() => {
      expect(mocks.invalidate).toHaveBeenCalled()
      expect(mocks.calculate).not.toHaveBeenCalled()
    })
    let run: ReturnType<typeof rendered.result.current.runReviewed>
    act(() => {
      run = rendered.result.current.runReviewed(
        { candidateId: 'candidate:a', vars: { length: 23 } },
        undefined,
        recorded,
      )
    })
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalledTimes(1))
    expect(recorded).toHaveBeenCalledExactlyOnceWith(41)
    expect(rendered.result.current.busy).toBe(true)
    await act(async () => {
      finish(summary)
      await run
    })
    expect(recorded).toHaveBeenCalledTimes(1)
  })
  it('runs reviewed Vars without regenerating them and preserves the candidate/result identity', async () => {
    const rendered = renderActions()
    const progress = vi.fn()
    await act(async () => {
      const result = await rendered.result.current.runReviewed(
        {
          candidateId: 'candidate:a',
          vars: { length: 23 },
          materialSnapshot,
        },
        progress,
      )
      expect(result).toMatchObject({ candidateId: 'candidate:a', measurementId: 41 })
    })
    expect(progress).toHaveBeenCalledWith({ measurementId: 41, state: 'succeeded', error: null })
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'candidate', vars: { length: 23 }, material_snapshot: materialSnapshot }),
    )
    expect(mocks.generate).not.toHaveBeenCalled()
    await act(async () => {
      await rendered.result.current.runReviewed({
        candidateId: 'measurement:42',
        measurementId: 42,
        vars: { length: 25 },
      })
    })
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'measurement', measurement_id: 42 }))
  })
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
    if (action === 'cancel') expect(mocks.cancel).toHaveBeenCalledWith('batch-1', undefined)
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
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'candidate',
        candidates: expect.objectContaining({ algorithm: 'monte-carlo', count: 2 }),
      }),
    )
    const sampler = mocks.create.mock.calls[0][0].candidates
    const values = await sampler.next(1, new AbortController().signal)
    expect(values.length).toBeGreaterThanOrEqual(10)
    expect(values.length).toBeLessThanOrEqual(50)
    expect(values.tensor).toEqual([2, 2])
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

  it.each(['failed', 'cancelled'])(
    'retries a %s Measurement outside cached pages and calculates only its new attempt',
    async (state) => {
      const execution = {
        measurement_id: 41,
        experiment_id: 10,
        recorded_at: null,
        batch_id: 'batch-1',
        job: { ...batch().jobs[0], state },
      }
      mocks.execution
        .mockResolvedValue({ ...execution, job: { ...execution.job, state: 'succeeded', attempt_count: 2 } })
        .mockResolvedValueOnce(execution)
      mocks.read.mockResolvedValue({ ...batch([42, 43]), state: 'running', finished_at: null, failed: 1 })
      const rendered = renderActions(measurement(41))
      act(() => {
        expect(rendered.result.current.runSelected()).toEqual(expect.any(String))
        expect(rendered.result.current.runSelected()).toBeNull()
      })
      await waitFor(() => expect(rendered.result.current.busy).toBe(false))
      expect(mocks.retry).toHaveBeenCalledExactlyOnceWith('batch-1', ['job-41'])
      expect(mocks.calculate.mock.calls.map(([id]) => id)).toEqual([41])
      expect(mocks.wait).not.toHaveBeenCalled()
      expect(mocks.create).not.toHaveBeenCalled()
    },
  )

  it('joins the existing job when concurrent registration wins', async () => {
    mocks.execution
      .mockResolvedValue({
        measurement_id: 41,
        experiment_id: 10,
        recorded_at: null,
        batch_id: 'batch-1',
        job: batch().jobs[0],
      })
      .mockResolvedValueOnce({ measurement_id: 41, experiment_id: 10, recorded_at: null, batch_id: null, job: null })
    mocks.create.mockRejectedValue(
      new ApiError(409, 'Already linked', { detail: { batch_id: 'batch-1', job_id: 'job-41' } }),
    )
    const rendered = renderActions(measurement(41))
    act(() => {
      rendered.result.current.runSelected()
    })
    await waitFor(() => expect(rendered.result.current.busy).toBe(false))
    expect(mocks.read).toHaveBeenCalledWith('batch-1', {}, true)
    expect(mocks.calculate).toHaveBeenCalledExactlyOnceWith(41, expect.any(Object))
    expect(mocks.retry).not.toHaveBeenCalled()
  })

  it('joins a concurrent retry without retrying its new attempt again', async () => {
    const execution = {
      measurement_id: 41,
      experiment_id: 10,
      recorded_at: null,
      batch_id: 'batch-1',
      job: batch().jobs[0],
    }
    mocks.execution
      .mockResolvedValue({ ...execution, job: { ...execution.job, attempt_count: 2 } })
      .mockResolvedValueOnce({ ...execution, job: { ...execution.job, state: 'failed' } })
    mocks.retry.mockRejectedValueOnce(new ApiError(409, 'Already retried', {}))
    const rendered = renderActions(measurement(41))
    await act(async () => {
      expect(
        await rendered.result.current.runReviewed({ candidateId: 'measurement:41', measurementId: 41, vars: {} }),
      ).toMatchObject({ measurementId: 41 })
    })
    expect(mocks.retry).toHaveBeenCalledOnce()
    expect(mocks.calculate).toHaveBeenCalledExactlyOnceWith(41, expect.any(Object))
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('delivers a selected cancellation again if retry was still in flight', async () => {
    mocks.execution.mockResolvedValue({
      measurement_id: 41,
      experiment_id: 10,
      recorded_at: null,
      batch_id: 'batch-1',
      job: { ...batch().jobs[0], state: 'cancelled' },
    })
    let finish!: (value: CaeBatch) => void
    mocks.retry.mockReturnValueOnce(
      new Promise<CaeBatch>((resolve) => {
        finish = resolve
      }),
    )
    const rendered = renderActions(measurement(41))
    let completion!: Promise<unknown>
    act(() => {
      completion = rendered.result.current
        .runReviewed({ candidateId: 'measurement:41', measurementId: 41, vars: {} })
        .catch((cause) => cause)
    })
    await waitFor(() => expect(mocks.retry).toHaveBeenCalledOnce())
    act(() => rendered.result.current.cancel())
    await act(async () => {
      finish(batch())
      expect(await completion).toMatchObject({ name: 'AbortError' })
    })
    expect(mocks.cancel.mock.calls).toEqual([
      ['batch-1', ['job-41']],
      ['batch-1', ['job-41']],
    ])
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it.each(['cleanup', 'recorded'])('refuses %s work without submitting or retrying', async (reason) => {
    mocks.execution.mockResolvedValue({
      measurement_id: 41,
      experiment_id: 10,
      recorded_at: reason === 'recorded' ? '2026-09-18' : null,
      batch_id: 'batch-1',
      job: { ...batch().jobs[0], state: 'failed', cleanup_pending: true },
    })
    const rendered = renderActions(measurement(41))
    act(() => {
      rendered.result.current.runSelected()
    })
    await waitFor(() =>
      expect(rendered.result.current.error).toContain(reason === 'cleanup' ? 'worker 정리' : '기록이 완료'),
    )
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(mocks.calculate).not.toHaveBeenCalled()
  })

  it('observes only the selected active job, ignores stale events and cancels only that job', async () => {
    mocks.execution.mockResolvedValue({
      measurement_id: 41,
      experiment_id: 10,
      recorded_at: null,
      batch_id: 'batch-1',
      job: { ...batch().jobs[0], state: 'running', attempt_count: 2 },
    })
    const rendered = renderActions(measurement(41))
    act(() => {
      rendered.result.current.runSelected()
    })
    await waitFor(() => expect(mocks.wait).toHaveBeenCalledOnce())
    mocks.events = [
      {
        id: 10,
        type: 'job.succeeded',
        batch_id: 'batch-1',
        job_id: 'job-41',
        attempt_count: 1,
        measurement_id: 41,
        payload: {},
        created_at: '',
      },
      {
        id: 11,
        type: 'job.succeeded',
        batch_id: 'batch-1',
        job_id: 'job-42',
        attempt_count: 2,
        measurement_id: 42,
        payload: {},
        created_at: '',
      },
    ]
    rendered.rerender({ sourceHash: 'source-hash' })
    expect(mocks.load).not.toHaveBeenCalled()
    expect(mocks.calculate).not.toHaveBeenCalled()
    act(() => rendered.result.current.cancel())
    expect(mocks.cancel).toHaveBeenCalledWith('batch-1', ['job-41'])
    expect(mocks.retry).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
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

it('prepares a hidden Geometry candidate before Save & Run, then submits its fresh material snapshot', async () => {
  const ensureFullEvaluation = vi.fn(async () => ({ variables: { length: 25 }, materialSnapshot }))
  const rendered = renderActions(null, { ...document, materialSnapshot: null, ensureFullEvaluation })
  await act(async () => {
    await rendered.result.current.saveAndRunCurrentAsync()
  })
  expect(ensureFullEvaluation).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ vars: { length: 25 }, material_snapshot: materialSnapshot }),
  )
})

it('cancels on-demand Candidate preparation without submitting a batch', async () => {
  const ensureFullEvaluation = vi.fn(
    (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }),
  )
  const rendered = renderActions(null, { ...document, materialSnapshot: null, ensureFullEvaluation })
  let completion!: Promise<unknown>
  act(() => {
    completion = rendered.result.current.saveAndRunCurrentAsync().catch((error) => error)
  })
  expect(rendered.result.current.busy).toBe(true)
  await act(async () => {
    rendered.result.current.cancel()
    await completion
  })
  expect(await completion).toMatchObject({ name: 'AbortError' })
  expect(mocks.create).not.toHaveBeenCalled()
  expect(rendered.result.current.busy).toBe(false)
})
