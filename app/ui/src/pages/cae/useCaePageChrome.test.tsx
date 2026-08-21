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
    experimentGraphDirty: false,
    experimentId: 42,
    experimentManageable: true,
    experimentName: 'Edited Experiment',
    experimentRecord: null,
    experimentStatus: 'Edited',
    geometry: { busy: false, draftVersions: {}, entryExports: [] },
    geometryGraphDirty: false,
    geometryLocalDraftDirty: false,
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
        geometryAuthoringState: null,
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
    expect(setDialog).toHaveBeenCalledWith('load-experiment')
  })
})
