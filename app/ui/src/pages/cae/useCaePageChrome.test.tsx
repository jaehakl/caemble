// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useCaePageChrome } from './useCaePageChrome'

afterEach(cleanup)

function workbench(newExperiment = vi.fn()) {
  return {
    experiment: {},
    experimentClean: false,
    experimentDirty: false,
    experimentDocument: {
      draftTaskNames: ['main'],
      materialParameters: null,
      runIsBusy: false,
      status: 'Ready',
      variables: null,
    },
    hasTasks: true,
    experimentId: 42,
    experimentManageable: true,
    experimentName: 'Edited Experiment',
    experimentRecord: null,
    experimentStatus: 'Edited',
    sourceLocked: false,
    measurementActions: {
      busy: false,
      cancel: vi.fn(),
      cancelable: false,
      deleteMeasurements: vi.fn(),
      generateAndRun: vi.fn(),
      generateAndRunBatch: null,
      generateCandidate: vi.fn(),
      operation: null,
      pendingRecordMeasurementId: null,
      retryRecord: vi.fn(),
      repeatGenerateAndRun: vi.fn(),
      saveCurrent: vi.fn(),
    },
    newExperiment,
    saving: null,
    selection: { measurement: null },
    simulation: { canRun: false },
  } as unknown as CaeWorkbenchState
}

function options(state: CaeWorkbenchState, overrides: Record<string, unknown> = {}) {
  return {
    analysisTab: 'explore',
    authenticated: false,
    experimentAuthoringState: null,
    guardReplacement: vi.fn((run: () => unknown) => run()),
    helpKind: 'manual',
    materialSelected: false,
    refreshRuntime: vi.fn(),
    requestAnalysisCommand: vi.fn(),
    requestLabCommand: vi.fn(),
    requestMaterialCommand: vi.fn(),
    requestRunSelected: vi.fn(),
    runSafely: vi.fn((run: () => unknown) => run()),
    setActiveSection: vi.fn(),
    setAnalysisTab: vi.fn(),
    setDialog: vi.fn(),
    setHelpKind: vi.fn(),
    workbench: state,
    ...overrides,
  } as Parameters<typeof useCaePageChrome>[0]
}

describe('CAE page contextual ribbon actions', () => {
  it('replaces through the dirty guard and keeps the Experiment section active', () => {
    const newExperiment = vi.fn()
    const state = workbench(newExperiment)
    const params = options(state)
    const { result } = renderHook(() => useCaePageChrome(params))

    act(() => result.current.actions.newExperiment.onSelect())

    expect(params.guardReplacement).toHaveBeenCalledOnce()
    expect(newExperiment).toHaveBeenCalledWith(
      starterExperimentSourceBundle,
      'Starter Experiment',
      '로컬에서 즉시 편집할 수 있는 Starter Box Experiment입니다.',
    )
    expect(params.setActiveSection).toHaveBeenCalledWith('experiment')
    expect(result.current.ribbonPanels.map((panel) => panel.sectionId)).toEqual([
      'experiment',
      'measurement',
      'material',
      'analysis',
      'lab',
      'help',
      'setting',
    ])
    expect(result.current.actions).not.toHaveProperty('duplicateMeasurement')
  })

  it('allows metadata Save for a clean locked Version and blocks dirty source', () => {
    const setDialog = vi.fn()
    const lockedClean = {
      ...workbench(),
      experimentClean: true,
      experimentDirty: false,
      experimentRecord: { id: 42 },
      sourceLocked: true,
    } as unknown as CaeWorkbenchState
    const cleanParams = options(lockedClean, { authenticated: true, setDialog })
    const { result, unmount } = renderHook(() => useCaePageChrome(cleanParams))

    expect(result.current.actions.saveExperiment.disabled).not.toBe(true)
    act(() => result.current.actions.saveExperiment.onSelect())
    expect(setDialog).toHaveBeenCalledWith('save-experiment')
    unmount()

    const lockedDirty = { ...lockedClean, experimentClean: false, experimentDirty: true }
    const dirty = renderHook(() => useCaePageChrome(options(lockedDirty, { authenticated: true })))
    expect(dirty.result.current.actions.saveExperiment).toMatchObject({
      disabled: true,
      disabledReason: '연결 데이터가 있는 Version은 잠겨 있습니다. Save New Version을 사용하세요.',
    })
  })

  it('routes Analysis, Help, Lab, and Material ribbon commands through typed callbacks', () => {
    const params = options(workbench(), { materialSelected: true })
    const { result } = renderHook(() => useCaePageChrome(params))

    act(() => {
      result.current.actions.analyzeMeasurements.onSelect()
      result.current.actions.materialEdit.onSelect()
      result.current.actions.materialDelete.onSelect()
      result.current.actions.labEnd.onSelect()
      result.current.actions.analysisReload.onSelect()
    })

    expect(params.setActiveSection).toHaveBeenCalledWith('analysis')
    expect(params.requestMaterialCommand).toHaveBeenNthCalledWith(1, 'edit')
    expect(params.requestMaterialCommand).toHaveBeenNthCalledWith(2, 'delete')
    expect(params.requestLabCommand).toHaveBeenCalledWith('end')
    expect(params.requestAnalysisCommand).toHaveBeenCalledWith('reload')
  })

  it('places Generate & Run, the default repeat count, Repeat Run, and Run in order', () => {
    const state = workbench()
    const generateAndRun = vi.fn()
    const repeatGenerateAndRun = vi.fn()
    const eligible = {
      ...state,
      experimentClean: true,
      experimentDocument: { ...state.experimentDocument, draftTaskNames: [], runIsBusy: false },
      measurementActions: { ...state.measurementActions, generateAndRun, repeatGenerateAndRun },
    } as unknown as CaeWorkbenchState
    const params = options(eligible, { authenticated: true })
    const { result, unmount } = renderHook(() => useCaePageChrome(params))
    const measurement = result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!

    render(<TooltipProvider delayDuration={0}>{measurement.content}</TooltipProvider>)
    const generateButton = screen.getByRole('button', { name: 'Generate & Run' })
    const repeatInput = screen.getByRole('spinbutton', { name: 'Repeat Run 횟수' })
    const repeatButton = screen.getByRole('button', { name: 'Repeat Run' })
    const runButton = screen.getByRole('button', { name: /^Run:/ })
    expect(repeatInput).toHaveValue(10)
    expect(repeatInput).not.toHaveAttribute('max')
    expect(generateButton.compareDocumentPosition(repeatInput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(repeatInput.compareDocumentPosition(repeatButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(repeatButton.compareDocumentPosition(runButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    act(() => generateButton.click())
    act(() => repeatButton.click())
    expect(params.runSafely).toHaveBeenCalledTimes(2)
    expect(generateAndRun).toHaveBeenCalledOnce()
    expect(repeatGenerateAndRun).toHaveBeenCalledWith(10)
    unmount()
    cleanup()

    const cancel = vi.fn()
    const running = {
      ...eligible,
      measurementActions: {
        ...eligible.measurementActions,
        busy: true,
        cancel,
        cancelable: true,
        operation: 'generate-and-run',
      },
    } as unknown as CaeWorkbenchState
    const cancelling = renderHook(() => useCaePageChrome(options(running, { authenticated: true })))
    const runningPanel = cancelling.result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!
    render(<TooltipProvider delayDuration={0}>{runningPanel.content}</TooltipProvider>)

    act(() => screen.getByRole('button', { name: 'Cancel' }).click())
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('validates positive safe repeat counts and assigns Cancel to the active Repeat Run only', () => {
    const state = workbench()
    const eligible = {
      ...state,
      experimentClean: true,
      experimentDocument: { ...state.experimentDocument, draftTaskNames: [], runIsBusy: false },
    } as unknown as CaeWorkbenchState
    const hook = renderHook(() => useCaePageChrome(options(eligible, { authenticated: true })))
    let measurement = hook.result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!
    const view = render(<TooltipProvider delayDuration={0}>{measurement.content}</TooltipProvider>)
    const input = screen.getByRole('spinbutton', { name: 'Repeat Run 횟수' })

    fireEvent.change(input, { target: { value: '0' } })
    measurement = hook.result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!
    view.rerender(<TooltipProvider delayDuration={0}>{measurement.content}</TooltipProvider>)
    expect(screen.getByRole('spinbutton', { name: 'Repeat Run 횟수' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: /Repeat Run: 반복 횟수는 양의 정수여야 합니다/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    )

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Repeat Run 횟수' }), {
      target: { value: String(Number.MAX_SAFE_INTEGER) },
    })
    measurement = hook.result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!
    view.rerender(<TooltipProvider delayDuration={0}>{measurement.content}</TooltipProvider>)
    expect(screen.getByRole('button', { name: 'Repeat Run' })).not.toHaveAttribute('aria-disabled', 'true')
    hook.unmount()
    cleanup()

    const cancel = vi.fn()
    const repeating = {
      ...eligible,
      measurementActions: {
        ...eligible.measurementActions,
        busy: true,
        cancel,
        cancelable: true,
        generateAndRunBatch: { attempt: 3, failures: 1, repeat: true, successes: 1, total: 10 },
        operation: 'generate-and-run',
      },
    } as unknown as CaeWorkbenchState
    const running = renderHook(() => useCaePageChrome(options(repeating, { authenticated: true })))
    const runningPanel = running.result.current.ribbonPanels.find((panel) => panel.sectionId === 'measurement')!
    render(<TooltipProvider delayDuration={0}>{runningPanel.content}</TooltipProvider>)

    expect(screen.getByRole('button', { name: 'Generate & Run: 다른 CAE 작업이 진행 중입니다.' })).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByRole('spinbutton', { name: 'Repeat Run 횟수' })).toBeDisabled()
    act(() => screen.getByRole('button', { name: 'Cancel' }).click())
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('marks only the selected Analysis and Help ribbon selectors as pressed', () => {
    const params = options(workbench(), { analysisTab: 'prediction', helpKind: 'solvers' })
    const { result } = renderHook(() => useCaePageChrome(params))
    const analysis = result.current.ribbonPanels.find((panel) => panel.sectionId === 'analysis')!
    const help = result.current.ribbonPanels.find((panel) => panel.sectionId === 'help')!

    render(
      <TooltipProvider delayDuration={0}>
        {analysis.content}
        {help.content}
      </TooltipProvider>,
    )

    expect(screen.getByRole('button', { name: 'Prediction' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Explore' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Solvers' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Manual' })).toHaveAttribute('aria-pressed', 'false')
  })
})
