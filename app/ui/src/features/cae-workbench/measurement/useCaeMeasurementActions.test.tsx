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
  deleteRows: vi.fn(),
  record: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: { Measurement: { create: mocks.create, deleteRows: mocks.deleteRows, record: mocks.record } },
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
    candidateGeneration: 1,
    completedCandidateGeneration: 1,
    draftTaskNames: [],
    materialParameters: {
      schemaVersion: 2,
      experiment: { schemaVersion: 1, materials: {} },
      tasks: { main: { schemaVersion: 1, materials: {} } },
    },
    revision: 2,
    runIsBusy: false,
    status: 'Ready',
    successfulCandidateGeneration: 1,
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
  mocks.deleteRows.mockResolvedValue(undefined)
  mocks.create.mockReset().mockResolvedValue({ id: 12 })
})

describe('useCaeMeasurementActions', () => {
  it('waits for the requested Candidate generation and the saved Measurement revision before running', async () => {
    mocks.record.mockRejectedValueOnce(new Error('response was lost'))
    const generate = vi.fn(() => 4)
    const run = vi.fn(() => 'run-generated')
    const saved = { ...prepared, id: 12, vars: { width: 9 } }
    const loadMeasurement = vi.fn().mockResolvedValue(saved)
    const currentSelection = selection({ loadMeasurement })
    const initialSimulation = simulationController({ canRun: false, run })
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController({
        candidateGeneration: 3,
        completedCandidateGeneration: 3,
        successfulCandidateGeneration: 3,
      }),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: generate,
      selection: currentSelection,
      simulation: initialSimulation,
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => expect(result.current.generateAndRun()).toBe(true))
    expect(generate).toHaveBeenCalledOnce()
    expect(result.current.stage).toBe('Candidate 생성')
    expect(mocks.create).not.toHaveBeenCalled()

    rerender({
      ...initialProps,
      experimentDocument: documentController({
        candidateGeneration: 4,
        completedCandidateGeneration: 3,
        revision: 3,
        successfulCandidateGeneration: 3,
        successfulRevision: 3,
      }),
    })
    expect(mocks.create).not.toHaveBeenCalled()

    const generatedDocument = documentController({
      candidateGeneration: 4,
      completedCandidateGeneration: 4,
      revision: 3,
      successfulCandidateGeneration: 4,
      successfulRevision: 3,
      variables: { width: 9 },
    })
    rerender({ ...initialProps, experimentDocument: generatedDocument })
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ vars: { width: 9 } }))
    await waitFor(() => expect(currentSelection.loadMeasurement).toHaveBeenCalledWith(12, 7))
    expect(run).not.toHaveBeenCalled()

    rerender({
      ...initialProps,
      experimentDocument: generatedDocument,
      selection: selection({ measurement: saved, loadMeasurement: currentSelection.loadMeasurement }),
    })
    expect(run).not.toHaveBeenCalled()

    rerender({
      ...initialProps,
      experimentDocument: documentController({ revision: 4, status: 'Evaluating', successfulRevision: -1 }),
      selection: selection({ measurement: saved, loadMeasurement: currentSelection.loadMeasurement }),
    })
    expect(run).not.toHaveBeenCalled()

    const recordedDocument = documentController({
      revision: 4,
      successfulRevision: 4,
      simulationProgram: { recordedData: { temperature: { dtype: 'float64', tensorOrder: 0 } } } as never,
    })
    const selectedSaved = selection({ measurement: saved, loadMeasurement: currentSelection.loadMeasurement })
    rerender({
      ...initialProps,
      experimentDocument: recordedDocument,
      selection: selectedSaved,
      simulation: simulationController({ run }),
    })
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    expect(result.current.stage).toBe('Simulation 실행')

    rerender({
      ...initialProps,
      experimentDocument: recordedDocument,
      selection: selectedSaved,
      simulation: simulationController({
        process: {
          engine: { name: 'caemble-cae', version: '1' },
          error: null,
          finishedAt: Date.now(),
          runId: 'run-generated',
          stage: null,
          startedAt: Date.now(),
          status: 'succeeded',
        },
        recordedData: { temperature: { value: 300 } },
        run,
      }),
    })
    await waitFor(() => expect(mocks.record).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(result.current.pendingRecordMeasurementId).toBe(12)

    mocks.record.mockRejectedValueOnce({ status: 409 })
    loadMeasurement.mockResolvedValueOnce({ ...saved, recorded_at: '2026-08-24T00:00:00Z' })
    await act(async () => void (await result.current.retryRecord()))
    await waitFor(() => expect(result.current.pendingRecordMeasurementId).toBeNull())
  })

  it('stops before saving when the generated Candidate evaluation fails', async () => {
    const run = vi.fn()
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection(),
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({
      ...initialProps,
      experimentDocument: documentController({
        error: { title: 'Experiment Error', message: 'candidate failed' },
        revision: 3,
        status: 'Error',
        successfulCandidateGeneration: 0,
        successfulRevision: -1,
      }),
    })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledWith('candidate failed')
    expect(mocks.create).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not start the pipeline twice before the first click rerenders', () => {
    const generate = vi.fn(() => 1)
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: generate,
          selection: selection(),
          simulation: simulationController({ canRun: false }),
        }),
      { wrapper: wrapper() },
    )

    act(() => {
      expect(result.current.generateAndRun()).toBe(true)
      expect(result.current.generateAndRun()).toBe(false)
    })
    expect(generate).toHaveBeenCalledOnce()
  })

  it('stops when saving the generated Candidate fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('create failed'))
    const run = vi.fn()
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection(),
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledWith('create failed')
    expect(initialProps.selection.loadMeasurement).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('ignores a late create response after the Experiment changes and retains the Prepared Measurement', async () => {
    let resolveCreate!: (value: { id: number }) => void
    mocks.create.mockImplementationOnce(() => new Promise((resolve) => (resolveCreate = resolve)))
    const run = vi.fn()
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection(),
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })
    await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce())
    rerender({ ...initialProps, experimentClean: false })
    await waitFor(() => expect(result.current.busy).toBe(false))
    resolveCreate({ id: 12 })
    await act(async () => await Promise.resolve())

    expect(initialProps.selection.loadMeasurement).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it('stops after a saved Measurement cannot be refreshed', async () => {
    const run = vi.fn()
    const currentSelection = selection({ loadMeasurement: vi.fn().mockRejectedValue(new Error('refresh failed')) })
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: currentSelection,
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.create).toHaveBeenCalledOnce()
    expect(run).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
    expect(result.current.error).toContain('저장되었지만 Generate & Run을 계속할 수 없습니다')
  })

  it('stops when the saved Measurement evaluation fails', async () => {
    const run = vi.fn()
    const saved = { ...prepared, id: 12 }
    const loadMeasurement = vi.fn().mockResolvedValue(saved)
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection({ loadMeasurement }),
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })
    await waitFor(() => expect(loadMeasurement).toHaveBeenCalledWith(12, 7))
    rerender({
      ...initialProps,
      experimentDocument: documentController({
        error: { title: 'Measurement Error', message: 'measurement failed' },
        revision: 4,
        status: 'Error',
        successfulRevision: -1,
      }),
      selection: selection({ measurement: saved, loadMeasurement }),
    })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledWith('measurement failed')
    expect(run).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it('stops when the evaluated saved Measurement cannot run', async () => {
    const run = vi.fn()
    const saved = { ...prepared, id: 12 }
    const loadMeasurement = vi.fn().mockResolvedValue(saved)
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection({ loadMeasurement }),
      simulation: simulationController({ canRun: false, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })
    await waitFor(() => expect(loadMeasurement).toHaveBeenCalledWith(12, 7))
    rerender({
      ...initialProps,
      experimentDocument: documentController({ revision: 4, successfulRevision: 4 }),
      selection: selection({ measurement: saved, loadMeasurement }),
    })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.toastError).toHaveBeenCalledWith('저장된 Measurement를 실행할 수 없습니다.')
    expect(run).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it('retains the generated Prepared Measurement when its Simulation is cancelled', async () => {
    const run = vi.fn(() => 'run-generated')
    const cancel = vi.fn()
    const saved = { ...prepared, id: 12 }
    const loadMeasurement = vi.fn().mockResolvedValue(saved)
    const initialProps = {
      authenticated: true,
      experimentClean: true,
      experimentDocument: documentController(),
      experimentId: 7,
      experimentSourceHash: sourceHash,
      onGenerateCandidate: vi.fn(() => 1),
      selection: selection({ loadMeasurement }),
      simulation: simulationController({ canRun: false, cancel, run }),
    }
    const { result, rerender } = renderHook((props) => useCaeMeasurementActions(props), {
      initialProps,
      wrapper: wrapper(),
    })

    act(() => result.current.generateAndRun())
    rerender({ ...initialProps, experimentDocument: documentController({ revision: 3, successfulRevision: 3 }) })
    await waitFor(() => expect(loadMeasurement).toHaveBeenCalledWith(12, 7))
    const selectedSaved = selection({ measurement: saved, loadMeasurement })
    rerender({
      ...initialProps,
      experimentDocument: documentController({ revision: 4, successfulRevision: 4 }),
      selection: selectedSaved,
      simulation: simulationController({ cancel, run }),
    })
    await waitFor(() => expect(run).toHaveBeenCalledOnce())
    rerender({
      ...initialProps,
      experimentDocument: documentController({ revision: 4, successfulRevision: 4 }),
      selection: selectedSaved,
      simulation: simulationController({
        cancel,
        process: {
          engine: { name: 'caemble-cae', version: '1' },
          error: null,
          finishedAt: null,
          runId: 'run-generated',
          stage: 'solve',
          startedAt: Date.now(),
          status: 'running',
        },
        run,
      }),
    })
    expect(result.current.cancelable).toBe(true)
    act(() => result.current.cancel())
    expect(cancel).toHaveBeenCalledOnce()
    rerender({
      ...initialProps,
      experimentDocument: documentController({ revision: 4, successfulRevision: 4 }),
      selection: selectedSaved,
      simulation: simulationController({
        cancel,
        process: {
          engine: { name: 'caemble-cae', version: '1' },
          error: 'cancelled',
          finishedAt: Date.now(),
          runId: 'run-generated',
          stage: null,
          startedAt: Date.now(),
          status: 'cancelled',
        },
        run,
      }),
    })

    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(mocks.deleteRows).not.toHaveBeenCalled()
    expect(mocks.record).not.toHaveBeenCalled()
  })

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
          onGenerateCandidate: vi.fn(() => 1),
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
          onGenerateCandidate: vi.fn(() => 1),
          selection: selection({ measurement: prepared }),
          simulation,
        }),
      { wrapper: wrapper() },
    )

    act(() => expect(result.current.runSelected()).toBe('run-1'))
    expect(simulation.run).toHaveBeenCalledOnce()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('deletes multiple Measurements and clears the active detail when it is included', async () => {
    const currentSelection = selection({ measurement: prepared })
    const recorded = { ...prepared, id: 12, recorded_at: '2026-08-12T00:00:00Z' }
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(() => 1),
          selection: currentSelection,
          simulation: simulationController(),
        }),
      { wrapper: wrapper() },
    )

    await act(async () => expect(await result.current.deleteMeasurements([prepared, recorded])).toBe(true))

    expect(mocks.deleteRows).toHaveBeenCalledWith([11, 12])
    expect(currentSelection.clearMeasurement).toHaveBeenCalledOnce()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Measurement 2개를 삭제했습니다.')
  })

  it('reports deletion failures without clearing the active detail', async () => {
    mocks.deleteRows.mockRejectedValueOnce(new Error('delete failed'))
    const currentSelection = selection({ measurement: prepared })
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController(),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(() => 1),
          selection: currentSelection,
          simulation: simulationController(),
        }),
      { wrapper: wrapper() },
    )

    await act(async () => expect(await result.current.deleteMeasurements([prepared])).toBe(false))

    expect(currentSelection.clearMeasurement).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('delete failed')
  })

  it('blocks Measurement saves for a Solver-less Draft preview', async () => {
    const { result } = renderHook(
      () =>
        useCaeMeasurementActions({
          authenticated: true,
          experimentClean: true,
          experimentDocument: documentController({ draftTaskNames: ['main'] }),
          experimentId: 7,
          experimentSourceHash: sourceHash,
          onGenerateCandidate: vi.fn(() => 1),
          selection: selection(),
          simulation: simulationController({ canRun: false }),
        }),
      { wrapper: wrapper() },
    )

    await act(async () => void (await result.current.saveCurrent()))

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledOnce()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Solver가 선택되지 않은 Draft Task가 있어 Measurement를 저장할 수 없습니다.',
    )
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
          onGenerateCandidate: vi.fn(() => 1),
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
    const generate = vi.fn(() => 1)
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
          onGenerateCandidate: vi.fn(() => 1),
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
          onGenerateCandidate: vi.fn(() => 1),
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
