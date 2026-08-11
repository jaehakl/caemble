// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { useCaeWorkbenchState } from './useCaeWorkbenchState'

const mocks = vi.hoisted(() => ({
  experimentList: vi.fn(),
  sampleList: vi.fn(),
  setupList: vi.fn(),
  structureList: vi.fn(),
  toastError: vi.fn(),
}))

const workspace = {
  experimentDocument: {},
  simulation: {},
  structureDocument: {},
}

vi.mock('@/api', () => ({
  dbTables: {
    Experiment: { listRows: mocks.experimentList },
    Measurement: { listRows: vi.fn() },
    RecordedData: { listRows: vi.fn() },
    Sample: { listRows: mocks.sampleList },
    Setup: { listRows: mocks.setupList },
    Structure: { listRows: mocks.structureList },
  },
  getListRequest: (scope: string, selectedIds: number[] = []) => ({
    filter: {},
    limit: null,
    offset: 0,
    random: false,
    scope,
    search_text: null,
    selected_ids: selectedIds,
    sort: null,
    text_filter: {},
  }),
}))

vi.mock('@/features/viewer/current-cad-selection', () => ({
  useCurrentCadSelection: () => ({
    setCurrentExperimentId: vi.fn(),
    setCurrentStructureId: vi.fn(),
  }),
}))

vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: () => workspace,
}))

vi.mock('@/features/cae-workbench/measurement/useCaeMeasurementActions', () => ({
  useCaeMeasurementActions: () => ({
    busy: false,
    cancel: vi.fn(),
    cancelable: false,
    error: null,
    generateMeasurement: vi.fn(),
    generateSample: vi.fn(),
    generateSetup: vi.fn(),
    operation: null,
    performMeasurement: vi.fn(),
    stage: null,
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

function renderSavedPair() {
  const hook = renderHook(() => useCaeWorkbenchState(null, false), {
    wrapper: createWrapper(),
  })
  act(() => {
    hook.result.current.applyStructure({
      code: 'export default function structure() {}',
      description: null,
      id: 10,
      name: 'Structure',
      parent_id: null,
      user_id: 'user-1',
    })
    hook.result.current.applyExperiment({
      description: null,
      id: 20,
      name: 'Experiment',
      parent_id: null,
      source_bundle: defaultExperimentSourceBundle,
      user_id: 'user-1',
    })
  })
  expect(hook.result.current.structureId).toBe(10)
  expect(hook.result.current.experimentId).toBe(20)
  return hook
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.sampleList.mockReset()
  mocks.setupList.mockReset()
})

describe('CAE workbench selection 복원', () => {
  it('복원이 끝나기 전 ID를 보존하고 성공 후 실제 선택으로 이어간다', async () => {
    const sampleRequest = deferred<{ items: Array<Record<string, unknown>> }>()
    const setupRequest = deferred<{ items: Array<Record<string, unknown>> }>()
    mocks.sampleList.mockReturnValue(sampleRequest.promise)
    mocks.setupList.mockReturnValue(setupRequest.promise)
    const hook = renderSavedPair()

    act(() => {
      hook.result.current.restoreSelection({ sampleId: 101, setupId: 202, measurementId: null })
    })
    await waitFor(() => {
      expect(mocks.sampleList).toHaveBeenCalledOnce()
      expect(mocks.setupList).toHaveBeenCalledOnce()
    })
    expect(hook.result.current.selectionRestoring).toBe(true)
    expect(hook.result.current.selectionIds).toEqual({
      measurementId: null,
      sampleId: 101,
      setupId: 202,
    })

    await act(async () => {
      sampleRequest.resolve({
        items: [{ id: 101, structure_id: 10, vars: {}, material_parameters: {} }],
      })
      setupRequest.resolve({
        items: [{ id: 202, experiment_id: 20, vars: {}, material_parameters: {} }],
      })
      await Promise.all([sampleRequest.promise, setupRequest.promise])
    })
    await waitFor(() => expect(hook.result.current.selectionRestoring).toBe(false))
    expect(hook.result.current.selectionIds).toEqual({
      measurementId: null,
      sampleId: 101,
      setupId: 202,
    })
  })

  it('느린 이전 Research 요청이 더 최신 pair 선택을 덮지 않는다', async () => {
    const oldStructure = deferred<{ items: Array<Record<string, unknown>> }>()
    const oldExperiment = deferred<{ items: Array<Record<string, unknown>> }>()
    const newStructure = deferred<{ items: Array<Record<string, unknown>> }>()
    const newExperiment = deferred<{ items: Array<Record<string, unknown>> }>()
    mocks.structureList.mockReturnValueOnce(oldStructure.promise).mockReturnValueOnce(newStructure.promise)
    mocks.experimentList.mockReturnValueOnce(oldExperiment.promise).mockReturnValueOnce(newExperiment.promise)
    const hook = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: createWrapper() })
    let oldLoad!: Promise<void>
    let newLoad!: Promise<void>

    act(() => {
      oldLoad = hook.result.current.loadResearch(10, 20)
      newLoad = hook.result.current.loadResearch(11, 21)
    })
    await act(async () => {
      newStructure.resolve({
        items: [{ id: 11, user_id: 'user-1', name: 'New Structure', description: null, code: 'new' }],
      })
      newExperiment.resolve({
        items: [
          {
            id: 21,
            user_id: 'user-1',
            name: 'New Experiment',
            description: null,
            source_bundle: defaultExperimentSourceBundle,
          },
        ],
      })
      await newLoad
    })
    expect(hook.result.current.structureId).toBe(11)
    expect(hook.result.current.experimentId).toBe(21)

    await act(async () => {
      oldStructure.resolve({
        items: [{ id: 10, user_id: 'user-1', name: 'Old Structure', description: null, code: 'old' }],
      })
      oldExperiment.resolve({
        items: [
          {
            id: 20,
            user_id: 'user-1',
            name: 'Old Experiment',
            description: null,
            source_bundle: defaultExperimentSourceBundle,
          },
        ],
      })
      await oldLoad
    })
    expect(hook.result.current.structureId).toBe(11)
    expect(hook.result.current.experimentId).toBe(21)
  })

  it('복원 실패 후에도 draft의 ID를 잃지 않고 실패 상태로 대기를 끝낸다', async () => {
    const sampleRequest = deferred<{ items: Array<Record<string, unknown>> }>()
    const setupRequest = deferred<{ items: Array<Record<string, unknown>> }>()
    mocks.sampleList.mockReturnValue(sampleRequest.promise)
    mocks.setupList.mockReturnValue(setupRequest.promise)
    const hook = renderSavedPair()

    act(() => {
      hook.result.current.restoreSelection({ sampleId: 303, setupId: 404, measurementId: null })
    })
    await waitFor(() => expect(hook.result.current.selectionRestoring).toBe(true))
    expect(hook.result.current.selectionIds).toEqual({
      measurementId: null,
      sampleId: 303,
      setupId: 404,
    })

    await act(async () => {
      setupRequest.resolve({
        items: [{ id: 404, experiment_id: 20, vars: {}, material_parameters: {} }],
      })
      sampleRequest.reject(new Error('selection restore failed'))
      await Promise.resolve()
    })
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('selection restore failed'))
    expect(hook.result.current.selectionRestoring).toBe(false)
    expect(hook.result.current.selectionIds).toEqual({
      measurementId: null,
      sampleId: 303,
      setupId: 404,
    })
  })
})
