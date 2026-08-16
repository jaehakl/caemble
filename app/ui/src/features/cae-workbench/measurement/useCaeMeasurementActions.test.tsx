// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import type { SavedMeasurement } from '../types'
import type { CaeDataSelection } from './useCaeDataSelection'
import { useCaeMeasurementActions } from './useCaeMeasurementActions'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  record: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: { Measurement: { create: mocks.create, record: mocks.record } },
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

const sourceHash = 'a'.repeat(64)
const prepared: SavedMeasurement = {
  id: 11,
  experiment_id: 7,
  vars: { width: 2 },
  material_parameters: {
    schemaVersion: 2,
    experiment: { schemaVersion: 1, materials: {} },
    tasks: { main: { schemaVersion: 1, materials: {} } },
  },
  recorded_at: null,
}

function documentController(overrides: Partial<CadDocumentController> = {}) {
  return {
    materialParameters: {
      schemaVersion: 2,
      experiment: { schemaVersion: 1, materials: {} },
      tasks: { main: { schemaVersion: 1, materials: {} } },
    },
    revision: 2,
    runIsBusy: false,
    status: 'Ready',
    successfulRevision: 2,
    variables: { width: 2 },
    ...overrides,
  } as CadDocumentController
}

function simulationController(overrides: Partial<SimulationController> = {}) {
  return {
    canRun: true,
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
    run: vi.fn(() => 'run-1'),
    stale: false,
    ...overrides,
  } as SimulationController
}

function selection(overrides: Partial<CaeDataSelection> = {}) {
  return {
    clearAll: vi.fn(),
    clearMeasurement: vi.fn(),
    loadMeasurement: vi.fn().mockResolvedValue(prepared),
    loading: false,
    materialSnapshot: null,
    measurement: null,
    recordedData: null,
    recordedRows: [],
    recordedRules: [],
    variables: undefined,
    ...overrides,
  } as CaeDataSelection
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.record.mockReset()
  mocks.create.mockResolvedValue({ id: 12 })
})

describe('useCaeMeasurementActions', () => {
  it('saves the current evaluated condition without running a solver', async () => {
    const simulation = simulationController()
    const currentSelection = selection()
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: currentSelection,
          simulation,
        }),
      { wrapper: wrapper() },
    )

    await act(async () => void (await result.current.saveCurrent()))

    expect(mocks.create).toHaveBeenCalledWith({
      experiment_id: 7,
      experiment_source_hash: sourceHash,
      vars: { width: 2 },
      material_parameters: {
        schemaVersion: 2,
        experiment: { schemaVersion: 1, materials: {} },
        tasks: { main: { schemaVersion: 1, materials: {} } },
      },
    })
    expect(simulation.run).not.toHaveBeenCalled()
    expect(currentSelection.loadMeasurement).toHaveBeenCalledWith(12, 7)
  })

  it('runs only a selected prepared Measurement', () => {
    const simulation = simulationController()
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: selection({ measurement: prepared }),
          simulation,
        }),
      { wrapper: wrapper() },
    )

    act(() => expect(result.current.runSelected()).toBe('run-1'))
    expect(simulation.run).toHaveBeenCalledOnce()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('duplicates persisted values only after the current catalog-backed evaluation is ready', async () => {
    const currentSelection = selection()
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: currentSelection,
          simulation: simulationController(),
        }),
      { wrapper: wrapper() },
    )

    await act(async () => void (await result.current.duplicateMeasurement(prepared)))

    expect(mocks.create).toHaveBeenCalledWith({
      experiment_id: 7,
      experiment_source_hash: sourceHash,
      vars: prepared.vars,
      material_parameters: prepared.material_parameters,
    })
  })

  it('blocks duplicate writes when catalog-backed evaluation is unavailable', async () => {
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController({ status: 'Error', materialParameters: null }),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: selection(),
          simulation: simulationController(),
        }),
      { wrapper: wrapper() },
    )

    await act(async () => void (await result.current.duplicateMeasurement(prepared)))

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('저장할 Candidate 평가가 완료되지 않았습니다.')
  })

  it('refuses to rerun a recorded Measurement', async () => {
    const simulation = simulationController()
    const recorded = { ...prepared, recorded_at: '2026-08-12T00:00:00Z' }
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: selection({ measurement: recorded }),
          simulation,
        }),
      { wrapper: wrapper() },
    )

    act(() => expect(result.current.runSelected()).toBeNull())
    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('다시 실행할 수 없습니다')),
    )
    expect(simulation.run).not.toHaveBeenCalled()
  })

  it('generates an anonymous local Candidate without creating a Measurement', () => {
    const generate = vi.fn()
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: false,
          experimentClean: false,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: generate,
          selection: selection(),
          simulation: simulationController(),
        }),
      { wrapper: wrapper() },
    )

    act(() => result.current.generateCandidate())
    expect(generate).toHaveBeenCalledOnce()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps a completed session result available for record retry', async () => {
    mocks.record.mockRejectedValueOnce(new Error('response was lost')).mockRejectedValueOnce({ status: 409 })
    const currentSelection = selection({
      measurement: prepared,
      loadMeasurement: vi.fn().mockResolvedValue({ ...prepared, recorded_at: '2026-08-12T00:00:00Z' }),
    })
    const simulation = simulationController({
      process: {
        engine: { name: 'caemble-cae', version: '1' },
        error: null,
        finishedAt: Date.now(),
        runId: 'run-1',
        stage: null,
        startedAt: Date.now(),
        status: 'succeeded',
      },
      recordedData: { temperature: { value: 300 } },
    })
    const experimentDocument = documentController({
      simulationProgram: {
        recordedData: { temperature: { dtype: 'float64', tensorOrder: 0 } },
      } as never,
    })
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument,
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: currentSelection,
          simulation,
        }),
      { wrapper: wrapper() },
    )

    act(() => result.current.runSelected())
    await waitFor(() => expect(result.current.pendingRecordMeasurementId).toBe(11))
    expect(simulation.recordedData).toEqual({ temperature: { value: 300 } })

    await act(async () => void (await result.current.retryRecord()))
    await waitFor(() => expect(result.current.pendingRecordMeasurementId).toBeNull())
    expect(mocks.record).toHaveBeenCalledTimes(2)
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.stringContaining('이미 저장'))
  })

  it('does not ask for another record when only the post-save refresh fails', async () => {
    mocks.record.mockResolvedValueOnce({ id: 11 })
    const currentSelection = selection({
      measurement: prepared,
      loadMeasurement: vi.fn().mockRejectedValue(new Error('refresh failed')),
    })
    const simulation = simulationController({
      process: {
        engine: { name: 'caemble-cae', version: '1' },
        error: null,
        finishedAt: Date.now(),
        runId: 'run-1',
        stage: null,
        startedAt: Date.now(),
        status: 'succeeded',
      },
      recordedData: { temperature: { value: 300 } },
    })
    const experimentDocument = documentController({
      simulationProgram: {
        recordedData: { temperature: { dtype: 'float64', tensorOrder: 0 } },
      } as never,
    })
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument,
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(),
          selection: currentSelection,
          simulation,
        }),
      { wrapper: wrapper() },
    )

    act(() => result.current.runSelected())
    await waitFor(() => expect(mocks.record).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.busy).toBe(false))

    expect(result.current.pendingRecordMeasurementId).toBeNull()
    expect(currentSelection.clearMeasurement).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('서버에 저장되었지만'))
  })
})
