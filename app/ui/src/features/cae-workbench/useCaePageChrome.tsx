import { useMemo, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react'
import {
  Beaker,
  BookOpenText,
  ChartNoAxesCombined,
  FlaskConical,
  Info,
  Pencil,
  Play,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  SaveAll,
  SlidersHorizontal,
  Square,
} from 'lucide-react'
import {
  WorkbenchRibbonActions,
  WorkbenchRibbonAction,
  WorkbenchRibbonGroup,
  type WorkbenchAction,
  type WorkbenchRibbonPanel,
} from '@/features/cae-workbench/chrome'
import type { CalculationSaveState } from '@/features/calculation'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchSectionId } from '@/features/cae-workbench/types'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { WorkbenchDialog } from './caePageTypes'
import { GeometryAuthoringRibbon } from './GeometryAuthoringRibbon'

export type AnalysisRibbonCommand = 'reload'
export type PredictionRibbonCommand = 'settings' | 'details' | 'predict' | 'validate' | 'cancel'
export type PredictionRibbonState = Readonly<{
  busy: boolean
  canPredict: boolean
  canValidate: boolean
  status: string
  predictDisabledReason?: string
  validateDisabledReason?: string
}>

export function useCaePageChrome({
  authenticated,
  dataReadable,
  calculationDirty,
  calculationSaveState,
  experimentAuthoringState,
  guardReplacement,
  requestAnalysisCommand,
  requestCalculationSave,
  requestAccount,
  requestPredictionCommand,
  requestRunSelected,
  runSafely,
  setActiveSection,
  setDialog,
  workbench,
  predictionState,
  preflightControls,
  batchGenerationControl,
  requestExperimentSave,
  requestExperimentSaveAs,
  fileBusy = false,
}: {
  authenticated: boolean
  dataReadable: boolean
  calculationDirty: boolean
  calculationSaveState: CalculationSaveState
  experimentAuthoringState: CadEditorAuthoringState | null
  guardReplacement: (run: () => unknown | Promise<unknown>) => void
  requestAnalysisCommand: (command: AnalysisRibbonCommand) => void
  requestCalculationSave: () => void
  selectedCalculationId: number | null
  requestAccount: () => void
  requestPredictionCommand: (command: PredictionRibbonCommand) => void
  requestRunSelected: () => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setActiveSection: (section: WorkbenchSectionId) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
  predictionState: PredictionRibbonState
  preflightControls?: ReactNode
  batchGenerationControl?: ReactNode
  requestExperimentSave?: () => void
  requestExperimentSaveAs?: () => void
  fileBusy?: boolean
}) {
  const [repeatCountInput] = useState('10')
  const repeatCount = Number(repeatCountInput)
  const repeatCountValid = repeatCountInput.trim() !== '' && Number.isSafeInteger(repeatCount) && repeatCount > 0

  const actions = useMemo<Record<string, WorkbenchAction>>(() => {
    const loginReason = '로그인 후 사용할 수 있습니다.'
    const demoReadOnlyReason =
      workbench.experimentIsDemo && !workbench.experimentManageable
        ? '공개 Demo 원본과 데이터는 읽기 전용입니다.'
        : undefined
    const savedReason = '저장되고 편집되지 않은 Experiment가 필요합니다.'
    const sourceValidationReason = 'Experiment source 오류를 수정하고 의미 검사를 완료한 뒤 저장하세요.'
    const tasklessReason = !workbench.hasTasks
      ? 'Task가 없는 Experiment는 미리보기와 source 저장만 사용할 수 있습니다.'
      : undefined
    const caeBusy = workbench.measurementActions.busy || workbench.calculationDataActions.busy
    const busyReason = caeBusy ? '다른 CAE 작업이 진행 중입니다.' : undefined
    const sourceLockReason = busyReason ?? (workbench.saving ? 'Experiment 저장이 진행 중입니다.' : undefined)
    const evaluationBusyReason = workbench.experimentDocument.runIsBusy
      ? 'Experiment 평가가 진행 중입니다.'
      : busyReason
    const candidateEvaluationReason =
      workbench.experimentDocument.status !== 'Ready' ||
      workbench.experimentDocument.successfulRevision !== workbench.experimentDocument.revision ||
      !workbench.experimentDocument.variables ||
      !workbench.experimentDocument.materialSnapshot
        ? '저장할 Candidate 평가가 완료되지 않았습니다.'
        : undefined
    const draftPreviewReason = workbench.experimentDocument.draftTaskNames.length
      ? 'Solver가 선택되지 않은 Draft Task가 있어 Measurement 저장과 CAE 실행을 사용할 수 없습니다.'
      : undefined
    const selected = workbench.selection.measurement
    const cancellingSelectedRun =
      workbench.measurementActions.operation === 'measurement' && workbench.measurementActions.cancelable
    const cancellingGeneratedRun =
      workbench.measurementActions.operation === 'generate-and-run' &&
      workbench.measurementActions.cancelable &&
      !workbench.measurementActions.generateAndRunBatch?.repeat
    const cancellingCurrentRun =
      workbench.measurementActions.operation === 'save-and-run' && workbench.measurementActions.cancelable
    const cancellingRepeatRun =
      workbench.measurementActions.operation === 'generate-and-run' &&
      workbench.measurementActions.cancelable &&
      Boolean(workbench.measurementActions.generateAndRunBatch?.repeat)

    const defined: Record<string, WorkbenchAction> = {
      newExperiment: {
        id: 'new-experiment',
        label: '템플릿',
        icon: <FlaskConical />,
        onSelect: () => setDialog('templates'),
      },
      experimentInfo: {
        id: 'experiment-info',
        label: '실험 정보',
        icon: <Info />,
        disabled: !workbench.experiment,
        disabledReason: !workbench.experiment ? 'Experiment source가 없습니다.' : undefined,
        onSelect: () => setDialog('experiment-info'),
      },
      experimentHelp: {
        id: 'experiment-help',
        label: '도움말',
        icon: <BookOpenText />,
        onSelect: () => {
          window.open('/doc', '_blank', 'noopener,noreferrer')
        },
      },
      editDemoCopy: {
        id: 'edit-demo-copy',
        label: 'Edit a copy',
        icon: <Pencil />,
        disabled: !workbench.experimentRecord?.isDemo,
        disabledReason: !workbench.experimentRecord?.isDemo
          ? 'Demo Experiment를 열었을 때 사용할 수 있습니다.'
          : undefined,
        onSelect: () =>
          guardReplacement(() => {
            const demo = workbench.experimentRecord
            if (!demo?.isDemo) return
            workbench.newExperiment(demo.source_bundle, `${demo.name} Copy`, demo.description ?? '')
            setActiveSection('experiment')
          }),
      },
      saveExperiment: {
        primary: true,
        id: 'save-experiment',
        label: '저장',
        icon: <Save />,
        disabled:
          !authenticated ||
          !workbench.experiment ||
          !workbench.experimentSourceValidated ||
          Boolean(workbench.experimentRecord && !workbench.experimentManageable) ||
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : !workbench.experimentSourceValidated
              ? sourceValidationReason
              : workbench.experimentRecord && !workbench.experimentManageable
                ? '다른 사용자의 Experiment는 새로 저장을 사용하세요.'
                : sourceLockReason,
        onSelect: requestExperimentSave ?? (() => setDialog('save-experiment-as')),
      },
      saveExperimentAs: {
        id: 'save-experiment-as',
        label: '새로 저장',
        icon: <SaveAll />,
        disabled:
          !authenticated || !workbench.experiment || !workbench.experimentSourceValidated || workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : !workbench.experimentSourceValidated
              ? sourceValidationReason
              : sourceLockReason,
        onSelect: requestExperimentSaveAs ?? (() => setDialog('save-experiment-as')),
      },
      generateCandidate: {
        id: 'generate-candidate',
        label: '재생성',
        icon: <RotateCw />,
        disabled: !workbench.experiment || workbench.experimentDocument.runIsBusy || caeBusy,
        disabledReason: !workbench.experiment ? 'Experiment source가 없습니다.' : evaluationBusyReason,
        onSelect: workbench.measurementActions.generateCandidate,
      },
      saveCurrentMeasurement: {
        id: 'save-current-measurement',
        label: 'Save Current',
        icon: <Beaker />,
        disabled:
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            workbench.experimentDocument.status !== 'Ready' ||
            workbench.experimentDocument.successfulRevision !== workbench.experimentDocument.revision ||
            !workbench.experimentDocument.variables ||
            !workbench.experimentDocument.materialSnapshot ||
            caeBusy),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ??
            tasklessReason ??
            (!workbench.experimentClean
              ? savedReason
              : (draftPreviewReason ?? candidateEvaluationReason ?? evaluationBusyReason))),
        onSelect: () => (authenticated ? runSafely(workbench.measurementActions.saveCurrent) : requestAccount()),
      },
      saveAndRunCurrent: {
        id: 'save-and-run-current',
        label: cancellingCurrentRun ? 'Cancel' : 'Save & Run',
        icon: cancellingCurrentRun ? <Square /> : <Play />,
        disabled:
          !cancellingCurrentRun &&
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            Boolean(selected) ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            Boolean(candidateEvaluationReason) ||
            caeBusy),
        disabledReason: cancellingCurrentRun
          ? undefined
          : !authenticated
            ? loginReason
            : (demoReadOnlyReason ??
              tasklessReason ??
              (!workbench.experimentClean
                ? savedReason
                : selected
                  ? '선택한 Prepared Measurement는 Run을 사용하세요.'
                  : (draftPreviewReason ?? candidateEvaluationReason ?? evaluationBusyReason))),
        onSelect: cancellingCurrentRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(workbench.measurementActions.saveAndRunCurrent) : requestAccount()),
      },
      saveCalculation: {
        id: 'save-calculation',
        label: 'Save',
        icon: <Save />,
        shortcut: 'Ctrl+S / Cmd+S',
        disabled: authenticated && calculationSaveState.disabled,
        disabledReason: authenticated ? calculationSaveState.disabledReason : loginReason,
        pressed: calculationDirty,
        onSelect: () => (authenticated ? requestCalculationSave() : requestAccount()),
      },
      cancelCalculationData: {
        id: 'cancel-calculation-data',
        label: 'Cancel Data',
        icon: <Square />,
        onSelect: workbench.measurementActions.automaticCalculationData
          ? workbench.measurementActions.cancel
          : workbench.calculationDataActions.cancel,
      },
      calculateAllData: {
        id: 'calculate-all-data',
        label: '일괄 계산',
        icon: <SaveAll />,
        disabled: authenticated && (Boolean(demoReadOnlyReason) || !workbench.experimentId || caeBusy),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ?? (!workbench.experimentId ? '저장된 Experiment가 필요합니다.' : busyReason)),
        onSelect: () => (authenticated ? runSafely(workbench.calculationDataActions.calculateAll) : requestAccount()),
      },
      generateAndRun: {
        id: 'generate-and-run',
        label: cancellingGeneratedRun ? 'Cancel' : 'Generate & Run',
        icon: cancellingGeneratedRun ? <Square /> : <Rocket />,
        disabled:
          !cancellingGeneratedRun &&
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !workbench.experiment ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            workbench.experimentDocument.runIsBusy ||
            caeBusy ||
            workbench.saving !== null),
        disabledReason: cancellingGeneratedRun
          ? undefined
          : !authenticated
            ? loginReason
            : (demoReadOnlyReason ??
              (!workbench.experiment
                ? 'Experiment source가 없습니다.'
                : (tasklessReason ??
                  (!workbench.experimentClean
                    ? savedReason
                    : (draftPreviewReason ?? evaluationBusyReason ?? sourceLockReason))))),
        onSelect: cancellingGeneratedRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(workbench.measurementActions.generateAndRun) : requestAccount()),
      },
      repeatGenerateAndRun: {
        id: 'repeat-generate-and-run',
        label: cancellingRepeatRun ? 'Cancel' : 'Sample & Run',
        icon: cancellingRepeatRun ? <Square /> : <RefreshCw />,
        disabled:
          !cancellingRepeatRun &&
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !repeatCountValid ||
            !workbench.experiment ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            workbench.experimentDocument.runIsBusy ||
            caeBusy ||
            workbench.saving !== null),
        disabledReason: cancellingRepeatRun
          ? undefined
          : !repeatCountValid
            ? '반복 횟수는 양의 정수여야 합니다.'
            : !authenticated
              ? loginReason
              : (demoReadOnlyReason ??
                (!workbench.experiment
                  ? 'Experiment source가 없습니다.'
                  : (tasklessReason ??
                    (!workbench.experimentClean
                      ? savedReason
                      : (draftPreviewReason ?? evaluationBusyReason ?? sourceLockReason))))),
        onSelect: cancellingRepeatRun
          ? workbench.measurementActions.cancel
          : () =>
              authenticated
                ? runSafely(() => workbench.measurementActions.repeatGenerateAndRun(repeatCount))
                : requestAccount(),
      },
      runSelected: {
        id: 'run-selected',
        label: cancellingSelectedRun ? 'Cancel' : 'Run',
        icon: cancellingSelectedRun ? <Square /> : <Play />,
        disabled:
          !cancellingSelectedRun &&
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            !selected ||
            Boolean(selected?.recorded_at) ||
            caeBusy),
        disabledReason: cancellingSelectedRun
          ? undefined
          : !authenticated
            ? loginReason
            : (demoReadOnlyReason ??
              tasklessReason ??
              (!workbench.experimentClean
                ? savedReason
                : !selected
                  ? 'Prepared Measurement를 선택하세요.'
                  : selected.recorded_at
                    ? 'Recorded Measurement는 다시 실행할 수 없습니다.'
                    : (draftPreviewReason ?? evaluationBusyReason))),
        onSelect: cancellingSelectedRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(requestRunSelected) : requestAccount()),
      },
      analyzeMeasurements: {
        id: 'analyze-measurements',
        label: 'Analysis',
        icon: <ChartNoAxesCombined />,
        disabled: !dataReadable || (authenticated && !workbench.experimentClean),
        disabledReason: !dataReadable ? loginReason : !workbench.experimentClean ? savedReason : undefined,
        onSelect: () => setActiveSection('analysis'),
      },
      analysisReload: {
        id: 'analysis-reload',
        label: 'Reload',
        icon: <RefreshCw />,
        disabled: !dataReadable,
        disabledReason: !dataReadable ? '먼저 공개 Demo 또는 내 Experiment를 여세요.' : undefined,
        onSelect: () => requestAnalysisCommand('reload'),
      },
      predictionSettings: {
        id: 'prediction-settings',
        label: '데이터·모델 관리',
        icon: <SlidersHorizontal />,
        disabled: !dataReadable || predictionState.busy,
        disabledReason: !dataReadable
          ? '먼저 공개 Demo 또는 내 Experiment를 여세요.'
          : predictionState.busy
            ? '현재 Prediction 작업이 끝난 뒤 설정을 바꾸세요.'
            : undefined,
        onSelect: () => requestPredictionCommand('settings'),
      },
      predictionDetails: {
        id: 'prediction-details',
        label: 'Model Details',
        icon: <Info />,
        disabled: !dataReadable,
        disabledReason: !dataReadable ? '먼저 공개 Demo 또는 내 Experiment를 여세요.' : undefined,
        onSelect: () => requestPredictionCommand('details'),
      },
      predictionValidate: {
        id: 'prediction-validate',
        label: 'Save & Run',
        icon: <Play />,
        disabled: authenticated && !predictionState.canValidate,
        disabledReason: authenticated
          ? predictionState.validateDisabledReason
          : '로그인하여 저장하고 Simulation을 실행하세요.',
        onSelect: () => (authenticated ? requestPredictionCommand('validate') : requestAccount()),
      },
      predictionCancel: {
        id: 'prediction-cancel',
        label: 'Cancel',
        icon: <Square />,
        onSelect: () => requestPredictionCommand('cancel'),
      },
    }

    if (fileBusy) {
      for (const name of ['newExperiment', 'saveExperiment', 'saveExperimentAs', 'generateCandidate'])
        defined[name] = { ...defined[name], disabled: true }
    }
    if (!sourceLockReason) return defined
    const locked = new Set(['newExperiment', 'saveExperiment', 'saveExperimentAs'])
    return Object.fromEntries(
      Object.entries(defined).map(([key, action]) => [
        key,
        locked.has(key) ? { ...action, disabled: true, disabledReason: sourceLockReason } : action,
      ]),
    )
  }, [
    requestExperimentSave,
    requestExperimentSaveAs,
    fileBusy,
    authenticated,
    dataReadable,
    calculationDirty,
    calculationSaveState,
    guardReplacement,
    requestAnalysisCommand,
    requestCalculationSave,
    requestAccount,
    requestPredictionCommand,
    requestRunSelected,
    repeatCount,
    repeatCountValid,
    runSafely,
    setActiveSection,
    setDialog,
    predictionState,
    workbench,
  ])

  const ribbonPanels: readonly WorkbenchRibbonPanel[] = [
    {
      sectionId: 'experiment',
      label: 'Experiment',
      content: (
        <>
          <WorkbenchRibbonGroup label="파일">
            <WorkbenchRibbonAction action={actions.newExperiment} size="large" />
            <WorkbenchRibbonActions
              actions={[
                actions.saveExperiment,
                actions.saveExperimentAs,
                ...(workbench.experimentIsDemo ? [actions.editDemoCopy] : []),
              ]}
            />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="샘플">
            <WorkbenchRibbonAction action={actions.generateCandidate} size="large" />
            {batchGenerationControl}
          </WorkbenchRibbonGroup>
          {preflightControls ? (
            <WorkbenchRibbonGroup label="시뮬레이션">{preflightControls}</WorkbenchRibbonGroup>
          ) : null}
          <WorkbenchRibbonGroup label="CSG 요소 입력">
            <GeometryAuthoringRibbon state={experimentAuthoringState} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="정보">
            <WorkbenchRibbonActions actions={[actions.experimentInfo, actions.experimentHelp]} />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'calculation',
      label: 'Calculation',
      content: (
        <>
          <WorkbenchRibbonGroup label="후처리 데이터">
            <WorkbenchRibbonAction
              action={workbench.calculationDataActions.busy ? actions.cancelCalculationData : actions.calculateAllData}
              size="large"
            />
            {workbench.calculationDataActions.progress?.running ? (
              <div className="flex h-[72px] max-w-36 flex-col justify-center text-[10px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {workbench.calculationDataActions.progress.completed.toLocaleString()}/
                  {workbench.calculationDataActions.progress.total.toLocaleString()}
                </span>
                <span className="truncate" title={workbench.calculationDataActions.progress.stage}>
                  {workbench.calculationDataActions.progress.stage}
                </span>
              </div>
            ) : null}
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'prediction',
      label: 'Prediction',
      content: (
        <>
          <WorkbenchRibbonGroup label="Prediction">
            <WorkbenchRibbonActions actions={[actions.predictionSettings, actions.predictionDetails]} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="원격 Forward">
            <div className="flex h-[72px] min-w-36 flex-col justify-center px-2 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground">Vars → BoxGrid</span>
              <span className="max-w-48 truncate" title={predictionState.status}>
                {predictionState.status}
              </span>
            </div>
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Validation">
            <WorkbenchRibbonActions
              size="large"
              actions={predictionState.busy ? [actions.predictionCancel] : [actions.predictionValidate]}
            />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'analysis',
      label: 'Analysis',
      content: (
        <>
          <WorkbenchRibbonGroup label="View">
            <WorkbenchRibbonAction
              size="large"
              action={{
                id: 'analysis-explore',
                label: 'Explore',
                icon: <ChartNoAxesCombined />,
                pressed: true,
                onSelect: () => setActiveSection('analysis'),
              }}
            />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Data">
            <WorkbenchRibbonActions actions={[actions.analysisReload]} />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
  ]

  return { actions, ribbonPanels }
}
