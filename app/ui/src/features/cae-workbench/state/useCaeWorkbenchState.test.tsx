import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { UserData } from '@/api'
import { defaultWorkbenchLayoutState, type SavedExperiment, type WorkbenchDraft } from '../types'
import { useCaeWorkbenchState } from './useCaeWorkbenchState'

const mocks = vi.hoisted(() => ({
  clearBaseMeasurement: vi.fn(),
  loadBaseMeasurement: vi.fn(),
  measurement: {
    id: 41,
    experiment_id: 7,
    vars: { width: 2 },
    material_snapshot: {
      experiment: { materials: {} },
      tasks: {},
      sourceHash: 'source',
      varsHash: 'vars',
      modelDefinitions: [],
      selections: {},
    },
    recorded_at: '2026-09-03T00:00:00Z',
    calculation_data_count: 1,
  },
  recordedData: { temperature: { data: 320 } },
}))

vi.mock('@/features/measurement/useCaeDataSelection', async () => {
  const { useCallback, useState } = await import('react')
  return {
    useCaeDataSelection: () => {
      const [measurement, setMeasurement] = useState<typeof mocks.measurement | null>(mocks.measurement)
      const [recordedData, setRecordedData] = useState<Record<string, unknown>>(mocks.recordedData)
      const clearMeasurement = useCallback(() => {
        mocks.clearBaseMeasurement()
        setMeasurement(null)
        setRecordedData({})
      }, [])
      return {
        measurement,
        recordedRows: measurement ? [{ id: 51 }] : [],
        recordedData,
        flatRecordedData: recordedData,
        recordedRules: [],
        recordedSchemas: {},
        variables: measurement?.vars,
        materialSnapshot: measurement?.material_snapshot ?? null,
        loading: false,
        clearAll: clearMeasurement,
        clearMeasurement,
        loadMeasurement: mocks.loadBaseMeasurement,
      }
    },
  }
})

vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: () => ({
    experimentDocument: {
      completedCandidateGeneration: 0,
      draftTaskNames: [],
      generateCandidate: vi.fn(),
      materialSnapshot: null,
      resultSessionKey: 0,
      revision: 0,
      runIsBusy: false,
      simulationProgram: null,
      status: 'Idle',
      successfulCandidateGeneration: 0,
      successfulRevision: -1,
      validatedRevision: -1,
      variables: null,
      varsSchema: null,
    },
    simulation: {},
  }),
}))

vi.mock('@/features/calculation/useCalculationDataActions', () => ({
  useCalculationDataActions: () => ({}),
}))

vi.mock('@/features/measurement/useCaeMeasurementActions', () => ({
  useCaeMeasurementActions: () => ({}),
}))

const firstUser: UserData = {
  id: 'first',
  is_active: true,
  roles: ['user'],
  experiment_namespaces: ['first'],
}

const secondUser: UserData = {
  id: 'second',
  is_active: true,
  roles: ['user'],
  experiment_namespaces: ['second'],
}

const secondUserDraft: WorkbenchDraft = {
  savedAt: 2,
  experiment: {
    record: null,
    baselineBundle: null,
    document: null,
    name: 'Second user draft',
    description: '',
  },
  candidate: { vars: null, materialSnapshot: null },
  selection: { experimentId: null, measurementId: null, calculationId: null },
  layout: defaultWorkbenchLayoutState,
}

function savedExperiment(id: number): SavedExperiment {
  return {
    id,
    description: null,
    experiment_key: `experiment-${id}`,
    name: `Experiment ${id}`,
    namespace: 'first',
    repository_slug: `experiment-${id}`,
    source_bundle: { files: { 'experiment.tsx': 'export default null' } },
    source_hash: `hash-${id}`,
    user_id: 'first',
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
  } as SavedExperiment
}

beforeEach(() => {
  mocks.clearBaseMeasurement.mockClear()
  mocks.loadBaseMeasurement.mockReset().mockResolvedValue(mocks.measurement)
})

describe('useCaeWorkbenchState draft restoration', () => {
  it('clears the previous account Measurement and RecordedData before restoring a null selection', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result, rerender } = renderHook(({ user }) => useCaeWorkbenchState(user, true), {
      initialProps: { user: firstUser },
      wrapper,
    })

    expect(result.current.selection.measurement?.id).toBe(41)
    expect(result.current.selection.recordedData).toEqual(mocks.recordedData)

    rerender({ user: secondUser })
    act(() => result.current.restoreDraft(secondUserDraft))

    expect(mocks.clearBaseMeasurement).toHaveBeenCalledOnce()
    expect(result.current.selection.measurement).toBeNull()
    expect(result.current.selection.recordedRows).toEqual([])
    expect(result.current.selection.recordedData).toEqual({})
    expect(result.current.selectionContext).toEqual({
      experimentId: null,
      measurementId: null,
      calculationId: null,
    })
  })

  it('commits only the latest Experiment when requests finish out of order', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const pending = new Map<number, (value: unknown) => void>()
    vi.spyOn(queryClient, 'fetchQuery').mockImplementation((options) => {
      if (options.queryKey.includes('measurements')) return Promise.resolve({ items: [] }) as never
      return new Promise((resolve) => {
        const id = options.queryKey[options.queryKey.length - 1]
        if (typeof id !== 'number') throw new Error('Experiment detail key is missing its ID.')
        pending.set(id, resolve)
      })
    })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeWorkbenchState(firstUser, true), { wrapper })
    let first!: Promise<SavedExperiment>
    let second!: Promise<SavedExperiment>

    act(() => {
      first = result.current.loadExperiment(7)
      second = result.current.loadExperiment(8)
    })
    await waitFor(() => expect([...pending.keys()]).toEqual([7, 8]))

    act(() => pending.get(8)?.(savedExperiment(8)))
    await act(async () => void (await second))
    act(() => pending.get(7)?.(savedExperiment(7)))
    await act(async () => void (await first))

    expect(result.current.experimentId).toBe(8)
    expect(result.current.experimentName).toBe('Experiment 8')
  })

  it('clears both child selections atomically when the Experiment changes', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeWorkbenchState(firstUser, true), { wrapper })
    const experiment = savedExperiment(7)
    const selectedDraft: WorkbenchDraft = {
      ...secondUserDraft,
      experiment: {
        record: experiment,
        baselineBundle: experiment.source_bundle,
        document: { kind: 'experiment', sourceBundle: experiment.source_bundle },
        name: experiment.name,
        description: '',
      },
      selection: { experimentId: 7, measurementId: 41, calculationId: 12 },
    }

    act(() => result.current.restoreDraft(selectedDraft))
    expect(result.current.selectionContext).toEqual({ experimentId: 7, measurementId: 41, calculationId: 12 })

    act(() => result.current.applyExperiment(savedExperiment(8)))
    expect(result.current.selectionContext).toEqual({ experimentId: 8, measurementId: null, calculationId: null })
  })

  it('keeps same-parent Measurement and Calculation selections together and rejects foreign children', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeWorkbenchState(firstUser, true), { wrapper })

    act(() => result.current.applyExperiment(savedExperiment(7)))
    expect(result.current.selectCalculation({ experimentId: 7, calculationId: 12 })).toBe(true)
    await act(async () => void (await result.current.selection.loadMeasurement(mocks.measurement)))
    expect(result.current.selectionContext).toEqual({ experimentId: 7, measurementId: 41, calculationId: 12 })

    const callsBeforeForeignSelection = mocks.loadBaseMeasurement.mock.calls.length
    expect(result.current.selectCalculation({ experimentId: 8, calculationId: 13 })).toBe(false)
    await expect(
      result.current.selection.loadMeasurement({ ...mocks.measurement, experiment_id: 8 }),
    ).resolves.toBeNull()
    expect(mocks.loadBaseMeasurement).toHaveBeenCalledTimes(callsBeforeForeignSelection)
    expect(result.current.selectionContext).toEqual({ experimentId: 7, measurementId: 41, calculationId: 12 })
  })

  it('ignores late Measurement and Calculation selections from the previous Experiment', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const { result } = renderHook(() => useCaeWorkbenchState(firstUser, true), { wrapper })
    let resolveMeasurement!: (value: typeof mocks.measurement) => void
    mocks.loadBaseMeasurement.mockImplementationOnce(() => new Promise((resolve) => (resolveMeasurement = resolve)))

    act(() => result.current.applyExperiment(savedExperiment(7)))
    const staleCalculationSelection = result.current.selectCalculation
    let pendingMeasurement!: ReturnType<typeof result.current.selection.loadMeasurement>
    act(() => {
      pendingMeasurement = result.current.selection.loadMeasurement(mocks.measurement, 7)
    })
    act(() => result.current.applyExperiment(savedExperiment(8)))
    expect(staleCalculationSelection({ experimentId: 7, calculationId: 12 })).toBe(false)
    resolveMeasurement(mocks.measurement)
    await act(async () => void (await pendingMeasurement))

    expect(result.current.selectionContext).toEqual({ experimentId: 8, measurementId: null, calculationId: null })
  })
})

describe('Experiment automatic Measurement selection', () => {
  function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    return { client, ...renderHook(() => useCaeWorkbenchState(firstUser, true), { wrapper }) }
  }

  it('requests the newest recorded Measurement with an ID tie break and restores its candidate', async () => {
    const { client, result } = setup()
    const fetchQuery = vi.spyOn(client, 'fetchQuery').mockResolvedValue({ items: [mocks.measurement] } as never)
    await act(async () => {
      await result.current.loadExperiment(savedExperiment(7))
    })
    await waitFor(() => expect(result.current.selectionContext.measurementId).toBe(41))
    const key = fetchQuery.mock.calls[0][0].queryKey
    expect(key[key.length - 1]).toMatchObject({
      scope: 'visible',
      filter: { experiment_id: [7, 7] },
      null_filter: { recorded_at: 'is_not_null' },
      sort: [
        ['recorded_at', 'desc'],
        ['id', 'desc'],
      ],
      limit: 1,
    })
    expect(mocks.loadBaseMeasurement).toHaveBeenCalledWith(41, 7)
    expect(result.current.candidateVars).toEqual(mocks.measurement.vars)
    expect(result.current.candidateMaterialSnapshot).toEqual(mocks.measurement.material_snapshot)
    expect(result.current.selectionRestoring).toBe(false)
  })

  it('keeps the Experiment open with no Measurement when no recorded result exists', async () => {
    const { client, result } = setup()
    vi.spyOn(client, 'fetchQuery').mockResolvedValue({ items: [] } as never)
    await act(async () => {
      await result.current.loadExperiment(savedExperiment(7))
    })
    expect(result.current.experimentId).toBe(7)
    expect(result.current.selectionContext.measurementId).toBeNull()
    expect(mocks.loadBaseMeasurement).not.toHaveBeenCalled()
    expect(result.current.selectionRestoring).toBe(false)
  })

  it.each(['list', 'recorded data'])(
    'keeps the Experiment open on %s failure without selecting another result',
    async (failure) => {
      const { client, result } = setup()
      const fetchQuery = vi.spyOn(client, 'fetchQuery')
      const error = vi.spyOn(toast, 'error')
      if (failure === 'list') fetchQuery.mockRejectedValue(new Error('offline'))
      else {
        fetchQuery.mockResolvedValue({ items: [mocks.measurement] } as never)
        mocks.loadBaseMeasurement.mockRejectedValueOnce(new Error('offline'))
      }
      await act(async () => {
        await result.current.loadExperiment(savedExperiment(7))
      })
      await waitFor(() => expect(error).toHaveBeenCalledWith('offline'))
      expect(result.current.experimentId).toBe(7)
      expect(result.current.selectionContext.measurementId).toBeNull()
      expect(result.current.selectionRestoring).toBe(false)
      expect(fetchQuery).toHaveBeenCalledOnce()
    },
  )

  it.each(['experiment', 'new', 'manual'])(
    'ignores an automatic list response after a newer %s selection',
    async (action) => {
      const { client, result } = setup()
      let resolveList!: (value: unknown) => void
      vi.spyOn(client, 'fetchQuery').mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          }) as never,
      )
      let opening!: Promise<SavedExperiment>
      act(() => {
        opening = result.current.loadExperiment(savedExperiment(7))
      })
      if (action === 'experiment') act(() => result.current.applyExperiment(savedExperiment(8)))
      else if (action === 'new') act(() => result.current.newExperiment())
      else
        await act(async () => {
          await result.current.selection.loadMeasurement(mocks.measurement)
        })
      const calls = mocks.loadBaseMeasurement.mock.calls.length
      await act(async () => {
        resolveList({ items: [{ ...mocks.measurement, id: 99 }] })
        await opening
      })
      expect(mocks.loadBaseMeasurement).toHaveBeenCalledTimes(calls)
      expect(result.current.selectionContext.measurementId).toBe(action === 'manual' ? 41 : null)
      expect(result.current.experimentId).toBe(action === 'experiment' ? 8 : action === 'new' ? null : 7)
    },
  )

  it('does not commit a late automatic result after a manual Measurement wins', async () => {
    const { client, result } = setup()
    vi.spyOn(client, 'fetchQuery').mockResolvedValue({ items: [mocks.measurement] } as never)
    let resolveResult!: (value: typeof mocks.measurement) => void
    mocks.loadBaseMeasurement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResult = resolve
        }),
    )
    await act(async () => {
      await result.current.loadExperiment(savedExperiment(7))
    })
    await waitFor(() => expect(mocks.loadBaseMeasurement).toHaveBeenCalledWith(41, 7))
    const manual = { ...mocks.measurement, id: 42, vars: { width: 9 } }
    mocks.loadBaseMeasurement.mockResolvedValueOnce(manual)
    await act(async () => {
      await result.current.selection.loadMeasurement(manual)
    })
    await act(async () => resolveResult(mocks.measurement))
    expect(result.current.selectionContext.measurementId).toBe(42)
    expect(result.current.candidateVars).toEqual({ width: 9 })
  })
})
