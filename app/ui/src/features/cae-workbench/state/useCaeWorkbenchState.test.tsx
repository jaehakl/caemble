import type { PropsWithChildren } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
    material_parameters: { experiment: { materials: {} }, tasks: {} },
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
        materialSnapshot: measurement?.material_parameters ?? null,
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
      materialParameters: null,
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
  candidate: { vars: null, materialParameters: null },
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
    vi.spyOn(queryClient, 'fetchQuery').mockImplementation(
      (options) =>
        new Promise((resolve) => {
          const id = options.queryKey[options.queryKey.length - 1]
          if (typeof id !== 'number') throw new Error('Experiment detail key is missing its ID.')
          pending.set(id, resolve)
        }),
    )
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
