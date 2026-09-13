import { act, render, renderHook, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { CalculationSaveState } from '@/features/calculation'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { useCaePageChrome } from './useCaePageChrome'
import { WorkbenchRibbon } from './chrome/WorkbenchRibbon'
import { TooltipProvider } from '@/components/ui/tooltip'

function workbenchStub() {
  return {
    calculationDataActions: {
      busy: false,
      calculateAll: vi.fn(),
      calculateMeasurement: vi.fn(),
      calculateSelected: vi.fn(),
      cancel: vi.fn(),
      progress: null,
    },
    experiment: {},
    experimentClean: false,
    experimentDocument: {
      draftTaskNames: [],
      materialSnapshot: {},
      revision: 1,
      runIsBusy: false,
      status: 'Ready',
      successfulRevision: 1,
      variables: {},
    },
    experimentId: null,
    experimentIsDemo: false,
    experimentManageable: false,
    experimentRecord: null,
    experimentSourceValidated: true,
    hasTasks: true,
    measurementActions: {
      busy: false,
      cancel: vi.fn(),
      cancelable: false,
      generateAndRun: vi.fn(),
      generateAndRunBatch: null,
      generateCandidate: vi.fn(),
      operation: null,
      repeatGenerateAndRun: vi.fn(),
      saveAndRunCurrent: vi.fn(),
      saveCurrent: vi.fn(),
    },
    saving: null,
    selection: { measurement: null },
  } as unknown as CaeWorkbenchState
}

it('uses the sole New action to open Templates and removes the old Examples and Load actions', () => {
  const setDialog = vi.fn()
  const { result } = renderHook(() =>
    useCaePageChrome({
      analysisTab: 'explore',
      authenticated: false,
      calculationDirty: false,
      calculationSaveState: {} as CalculationSaveState,
      dataReadable: false,
      experimentAuthoringState: null,
      guardReplacement: vi.fn(),
      predictionState: {
        busy: false,
        canSample: false,
        canValidate: false,
        direction: 'forward',
        status: '',
      },
      requestAccount: vi.fn(),
      requestAnalysisCommand: vi.fn(),
      requestCalculationSave: vi.fn(),
      requestPredictionCommand: vi.fn(),
      requestRunSelected: vi.fn(),
      runSafely: vi.fn(),
      selectedCalculationId: null,
      setActiveSection: vi.fn(),
      setAnalysisTab: vi.fn(),
      setDialog,
      workbench: workbenchStub(),
    }),
  )

  expect(result.current.actions.newExperiment).toMatchObject({ id: 'new-experiment', label: 'New' })
  expect(result.current.actions).not.toHaveProperty('examples')
  expect(result.current.actions).not.toHaveProperty('loadExperiment')
  render(
    <TooltipProvider>
      <WorkbenchRibbon activeSectionId="calculation" panels={result.current.ribbonPanels} />
    </TooltipProvider>,
  )
  expect(screen.queryByRole('button', { name: /Candidate|Run|Analysis|Sample/ })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '후처리 데이터' })).toBeInTheDocument()

  act(() => result.current.actions.newExperiment.onSelect())
  expect(setDialog).toHaveBeenCalledExactlyOnceWith('templates')

  setDialog.mockClear()
  expect(result.current.actions.experimentInfo).toMatchObject({ id: 'experiment-info', label: 'Info', disabled: false })
  act(() => result.current.actions.experimentInfo.onSelect())
  expect(setDialog).toHaveBeenCalledExactlyOnceWith('experiment-info')
})

it('disables Experiment Info only when no Experiment is open', () => {
  const workbench = { ...workbenchStub(), experiment: null } as CaeWorkbenchState
  const { result } = renderHook(() =>
    useCaePageChrome({
      analysisTab: 'explore',
      authenticated: false,
      calculationDirty: false,
      calculationSaveState: {} as CalculationSaveState,
      dataReadable: false,
      experimentAuthoringState: null,
      guardReplacement: vi.fn(),
      predictionState: {
        busy: false,
        canSample: false,
        canValidate: false,
        direction: 'forward',
        status: '',
      },
      requestAccount: vi.fn(),
      requestAnalysisCommand: vi.fn(),
      requestCalculationSave: vi.fn(),
      requestPredictionCommand: vi.fn(),
      requestRunSelected: vi.fn(),
      runSafely: vi.fn(),
      selectedCalculationId: null,
      setActiveSection: vi.fn(),
      setAnalysisTab: vi.fn(),
      setDialog: vi.fn(),
      workbench,
    }),
  )

  expect(result.current.actions.experimentInfo).toMatchObject({
    disabled: true,
    disabledReason: 'Experiment source가 없습니다.',
  })
})
