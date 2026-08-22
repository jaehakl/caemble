// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import { useCaePageChrome } from './useCaePageChrome'

function workbench(newExperiment = vi.fn()) {
  return {
    experiment: {},
    experimentClean: false,
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

describe('CAE page source actions', () => {
  it('replaces through the dirty guard with Starter immediately and keeps Load public', () => {
    const newExperiment = vi.fn()
    const guardReplacement = vi.fn((run: () => unknown) => run())
    const openTab = vi.fn()
    const setDialog = vi.fn()
    const { result } = renderHook(() =>
      useCaePageChrome({
        authenticated: false,
        experimentAuthoringState: null,
        guardReplacement,
        openTab,
        requestRunSelected: vi.fn(),
        runSafely: vi.fn(),
        setDialog,
        workbench: workbench(newExperiment),
      }),
    )
    const [newAction, loadAction] = result.current.toolbar

    act(() => newAction.onSelect())
    expect(guardReplacement).toHaveBeenCalledOnce()
    expect(newExperiment).toHaveBeenCalledWith(
      starterExperimentSourceBundle,
      'Starter Experiment',
      '로컬에서 즉시 편집할 수 있는 Starter Box Experiment입니다.',
    )
    expect(openTab).toHaveBeenCalledWith('experiment')

    expect(loadAction.disabled).not.toBe(true)
    act(() => loadAction.onSelect())
    expect(openTab).toHaveBeenCalledWith('experiments')
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
    const { result, unmount } = renderHook(() =>
      useCaePageChrome({
        authenticated: true,
        experimentAuthoringState: null,
        guardReplacement: vi.fn(),
        openTab: vi.fn(),
        requestRunSelected: vi.fn(),
        runSafely: vi.fn(),
        setDialog,
        workbench: lockedClean,
      }),
    )

    const cleanSave = result.current.toolbar[2]
    expect(cleanSave.disabled).not.toBe(true)
    act(() => cleanSave.onSelect())
    expect(setDialog).toHaveBeenCalledWith('save-experiment')
    unmount()

    const lockedDirty = { ...lockedClean, experimentClean: false, experimentDirty: true }
    const dirty = renderHook(() =>
      useCaePageChrome({
        authenticated: true,
        experimentAuthoringState: null,
        guardReplacement: vi.fn(),
        openTab: vi.fn(),
        requestRunSelected: vi.fn(),
        runSafely: vi.fn(),
        setDialog,
        workbench: lockedDirty,
      }),
    )
    expect(dirty.result.current.toolbar[2]).toMatchObject({
      disabled: true,
      disabledReason: '연결 데이터가 있는 Version은 잠겨 있습니다. Save New Version을 사용하세요.',
    })
  })
})
