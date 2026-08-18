// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import type { SavedExperiment } from '../types'
import { useCaeWorkbenchState } from './useCaeWorkbenchState'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'

const mocks = vi.hoisted(() => ({
  experimentList: vi.fn(),
  setCurrentExperimentId: vi.fn(),
}))

const controller = {
  generateCandidate: vi.fn(),
  materialParameters: null,
  revision: 1,
  runIsBusy: false,
  status: 'Ready',
  successfulRevision: -1,
  variables: null,
}

vi.mock('@/api', () => ({
  dbTables: {
    Experiment: { listRows: mocks.experimentList },
    Measurement: { listRows: vi.fn() },
    RecordedData: { listRows: vi.fn() },
  },
  getListRequest: (scope: string, selectedIds: number[] = []) => ({
    filter: {},
    limit: 24,
    offset: 0,
    scope,
    search_text: null,
    selected_ids: selectedIds,
    sort: ['updated_at', 'desc'],
    text_filter: {},
  }),
}))
vi.mock('@/features/viewer/current-cad-selection', () => ({
  useCurrentCadSelection: () => ({ setCurrentExperimentId: mocks.setCurrentExperimentId }),
}))
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: () => ({ experimentDocument: controller, simulation: {} }),
}))
vi.mock('@/features/cae-workbench/measurement/useCaeMeasurementActions', () => ({
  useCaeMeasurementActions: () => ({
    busy: false,
    cancel: vi.fn(),
    cancelable: false,
    duplicateMeasurement: vi.fn(),
    error: null,
    generateCandidate: vi.fn(),
    operation: null,
    pendingRecordMeasurementId: null,
    retryRecord: vi.fn(),
    runSelected: vi.fn(),
    saveCurrent: vi.fn(),
    stage: null,
  }),
}))

const sourceHash = 'a'.repeat(64)
function experiment(id: number, name = `Experiment ${id}`): SavedExperiment {
  return {
    id,
    user_id: 'user-1',
    parent_id: null,
    name,
    description: null,
    source_bundle: defaultExperimentSourceBundle,
    source_hash: sourceHash,
  }
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('useCaeWorkbenchState', () => {
  it('owns a single Experiment and emits a v9 session draft', () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })

    act(() => result.current.applyExperiment(experiment(7)))

    expect(result.current.experimentId).toBe(7)
    expect(result.current.experimentRecord?.source_hash).toBe(sourceHash)
    expect(result.current).not.toHaveProperty('structureId')
    expect(result.current).not.toHaveProperty('pairClean')
    expect(
      result.current.draft({
        openTabs: ['experiment', 'recorded-data'],
        activeTab: 'experiment',
        experimentFile: 'experiment.tsx',
        splitPercent: 50,
      }),
    ).toMatchObject({
      version: 10,
      experiment: { record: { id: 7 } },
      candidate: { vars: null, materialParameters: null },
      selection: { measurementId: null },
      geometry: {
        drafts: {},
        stagedModules: [],
        selectedCoordinate: 'geometry.tsx',
        selectedExport: 'Conductor',
        expandedPaths: ['geometry.tsx'],
      },
    })
  })

  it('does not let an older load overwrite a newer Experiment', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise((resolve) => {
      resolveOld = resolve
    })
    mocks.experimentList.mockReturnValueOnce(old).mockResolvedValueOnce({ total: 1, items: [experiment(2)] })
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })

    let oldLoad!: Promise<SavedExperiment>
    await act(async () => {
      oldLoad = result.current.loadExperiment(1)
      await result.current.loadExperiment(2)
    })
    expect(result.current.experimentId).toBe(2)

    await act(async () => {
      resolveOld({ total: 1, items: [experiment(1)] })
      await oldLoad
    })
    expect(result.current.experimentId).toBe(2)
  })

  it('treats a newly opened local template as the clean baseline and becomes dirty after editing', () => {
    const { result } = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: wrapper() })

    act(() => result.current.newExperiment(starterExperimentSourceBundle, 'Starter Experiment'))
    expect(result.current.experimentDirty).toBe(false)
    expect(result.current.hasUnsavedWork).toBe(false)

    act(() => result.current.geometry.updateSource(`${starterExperimentSourceBundle.files['geometry.tsx']}\n// edited`))
    expect(result.current.experimentDirty).toBe(true)
    expect(result.current.hasUnsavedWork).toBe(true)
  })
})
