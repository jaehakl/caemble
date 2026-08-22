// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
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
      duplicateMeasurement: vi.fn(),
      generateCandidate: vi.fn(),
      operation: null,
      pendingRecordMeasurementId: null,
      retryRecord: vi.fn(),
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
    analysisTab: 'overview',
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

  it('guards Duplicate until an eligible Measurement is selected', () => {
    const base = workbench()
    const duplicateMeasurement = vi.fn()
    const eligibleWithoutSelection = {
      ...base,
      experimentClean: true,
      experimentDocument: {
        ...base.experimentDocument,
        draftTaskNames: [],
        materialParameters: {},
        variables: {},
      },
      measurementActions: { ...base.measurementActions, duplicateMeasurement },
      selection: { measurement: null },
      simulation: { ...base.simulation, canRun: true },
    } as unknown as CaeWorkbenchState
    const withoutSelection = options(eligibleWithoutSelection, { authenticated: true })
    const first = renderHook(() => useCaePageChrome(withoutSelection))

    expect(first.result.current.actions.duplicateMeasurement).toMatchObject({
      disabled: true,
      disabledReason: '복제할 Measurement를 선택하세요.',
    })
    act(() => first.result.current.actions.duplicateMeasurement.onSelect())
    expect(withoutSelection.runSafely).not.toHaveBeenCalled()
    expect(duplicateMeasurement).not.toHaveBeenCalled()
    first.unmount()

    const selected = { id: 9, recorded_at: null }
    const eligibleWithSelection = {
      ...eligibleWithoutSelection,
      selection: { measurement: selected },
    } as unknown as CaeWorkbenchState
    const withSelection = options(eligibleWithSelection, { authenticated: true })
    const second = renderHook(() => useCaePageChrome(withSelection))

    expect(second.result.current.actions.duplicateMeasurement.disabled).not.toBe(true)
    act(() => second.result.current.actions.duplicateMeasurement.onSelect())
    expect(withSelection.runSafely).toHaveBeenCalledOnce()
    expect(duplicateMeasurement).toHaveBeenCalledWith(selected)
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
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Solvers' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Manual' })).toHaveAttribute('aria-pressed', 'false')
  })
})
