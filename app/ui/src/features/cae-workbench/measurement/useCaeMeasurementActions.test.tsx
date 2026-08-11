// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import { useCaeMeasurementActions } from './useCaeMeasurementActions'
import type { CaeDataSelection } from './useCaeDataSelection'

const mocks = vi.hoisted(() => ({
  measurementSave: vi.fn(),
  sampleUpsert: vi.fn(),
  setupUpsert: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Measurement: { save: mocks.measurementSave },
    Sample: { upsertRow: mocks.sampleUpsert },
    Setup: { upsertRow: mocks.setupUpsert },
  },
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
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

function createDocument(overrides: Partial<CadDocumentController> = {}): CadDocumentController {
  return {
    handleReroll: vi.fn(),
    materialParameters: {},
    revision: 1,
    runIsBusy: false,
    status: 'Ready',
    successfulRevision: 1,
    variables: { value: 1 },
    ...overrides,
  } as CadDocumentController
}

function createSimulation(overrides: Partial<SimulationController> = {}): SimulationController {
  return {
    canRun: false,
    cancel: vi.fn(),
    process: {
      engine: null,
      error: null,
      finishedAt: null,
      runId: null,
      stage: null,
      startedAt: null,
      status: 'idle',
    },
    recordedData: null,
    run: vi.fn(),
    stale: false,
    ...overrides,
  }
}

function createSelection(overrides: Partial<CaeDataSelection> = {}): CaeDataSelection {
  return {
    clearAll: vi.fn(),
    clearMeasurement: vi.fn(),
    clearSample: vi.fn(),
    clearSetup: vi.fn(),
    experimentMaterialSnapshot: null,
    experimentVars: undefined,
    loadMeasurement: vi.fn(),
    loading: false,
    measurement: null,
    recordedData: null,
    recordedRows: [],
    recordedRules: [],
    sample: null,
    selectSample: vi.fn(),
    selectSetup: vi.fn(),
    setGeneratedSample: vi.fn(),
    setGeneratedSetup: vi.fn(),
    setup: null,
    structureMaterialSnapshot: null,
    structureVars: undefined,
    ...overrides,
  } as CaeDataSelection
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('CAE Measurement 비동기 단계', () => {
  it('평가 중에는 취소 가능하지만 저장이 시작되면 취소할 수 없다', async () => {
    const save = deferred<[{ id: number }]>()
    mocks.sampleUpsert.mockReturnValue(save.promise)
    const selection = createSelection()
    const initialStructure = createDocument()
    const experimentDocument = createDocument()
    const simulation = createSimulation()
    const hook = renderHook(
      ({ structureDocument }) =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument,
          experimentId: 20,
          pairClean: true,
          selection,
          simulation,
          structureClean: true,
          structureDocument,
          structureId: 10,
        }),
      {
        initialProps: { structureDocument: initialStructure },
        wrapper: createWrapper(),
      },
    )

    act(() => hook.result.current.generateSample())

    expect(hook.result.current.busy).toBe(true)
    expect(hook.result.current.cancelable).toBe(true)
    expect(hook.result.current.stage).toBe('Structure 평가 중')
    expect(initialStructure.handleReroll).toHaveBeenCalledOnce()

    hook.rerender({
      structureDocument: createDocument({ revision: 2, successfulRevision: 2 }),
    })
    await waitFor(() => expect(hook.result.current.stage).toBe('Sample 저장 중'))
    expect(hook.result.current.busy).toBe(true)
    expect(hook.result.current.cancelable).toBe(false)

    await act(async () => save.resolve([{ id: 101 }]))
    await waitFor(() => expect(hook.result.current.busy).toBe(false))
  })

  it('Measurement 평가와 실행 단계는 모두 취소 가능하다', async () => {
    const selection = createSelection({
      sample: { id: 101, structure_id: 10, vars: {}, material_parameters: {} },
      setup: { id: 202, experiment_id: 20, vars: {}, material_parameters: {} },
    })
    const structureDocument = createDocument()
    const experimentDocument = createDocument()
    const waitingSimulation = createSimulation()
    const run = vi.fn(() => 'run-1')
    const cancel = vi.fn()
    const hook = renderHook(
      ({ simulation }) =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument,
          experimentId: 20,
          pairClean: true,
          selection,
          simulation,
          structureClean: true,
          structureDocument,
          structureId: 10,
        }),
      {
        initialProps: { simulation: waitingSimulation },
        wrapper: createWrapper(),
      },
    )

    act(() => hook.result.current.performMeasurement())
    expect(hook.result.current.stage).toBe('선택 실현값 평가 중')
    expect(hook.result.current.cancelable).toBe(true)

    hook.rerender({
      simulation: createSimulation({
        canRun: true,
        cancel,
        process: {
          engine: null,
          error: null,
          finishedAt: null,
          runId: 'run-1',
          stage: 'Solving',
          startedAt: null,
          status: 'running',
        },
        run,
      }),
    })
    await waitFor(() => expect(hook.result.current.stage).toBe('Solving'))
    expect(run).toHaveBeenCalledOnce()
    expect(hook.result.current.cancelable).toBe(true)

    act(() => hook.result.current.cancel())
    expect(cancel).toHaveBeenCalledOnce()
    expect(hook.result.current.busy).toBe(false)
  })

  it('controller가 busy이면 Generate Measurement를 대기 상태로 남기지 않고 오류로 종료한다', () => {
    const selection = createSelection()
    const structureDocument = createDocument({ runIsBusy: true })
    const experimentDocument = createDocument()
    const hook = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument,
          experimentId: 20,
          pairClean: true,
          selection,
          simulation: createSimulation(),
          structureClean: true,
          structureDocument,
          structureId: 10,
        }),
      { wrapper: createWrapper() },
    )

    act(() => hook.result.current.generateMeasurement())

    expect(hook.result.current.busy).toBe(false)
    expect(hook.result.current.cancelable).toBe(false)
    expect(hook.result.current.stage).toBeNull()
    expect(hook.result.current.error).toBe('Structure와 Experiment source 평가가 끝난 뒤 다시 실행하세요.')
    expect(mocks.toastError).toHaveBeenCalledWith('Structure와 Experiment source 평가가 끝난 뒤 다시 실행하세요.')
    expect(selection.clearAll).not.toHaveBeenCalled()
    expect(structureDocument.handleReroll).not.toHaveBeenCalled()
    expect(experimentDocument.handleReroll).not.toHaveBeenCalled()
  })
})
