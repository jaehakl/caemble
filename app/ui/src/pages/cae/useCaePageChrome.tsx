import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  Beaker,
  BookOpenText,
  Boxes,
  ChartNoAxesCombined,
  CircleUserRound,
  Database,
  Download,
  FlaskConical,
  Gauge,
  GitBranch,
  Layers3,
  MessageCircle,
  Info,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  SaveAll,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import {
  WorkbenchRibbonActions,
  WorkbenchRibbonGroup,
  type WorkbenchAction,
  type WorkbenchRibbonPanel,
} from '@/features/cae-workbench/chrome'
import type { CalculationSaveState } from '@/features/cae-workbench/calculation'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, HelpKindId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import type { WorkbenchDialog } from './caePageTypes'
import { GeometryAuthoringRibbon } from './GeometryAuthoringRibbon'

export type AnalysisRibbonCommand = 'reload' | 'export-dataset'
export type PredictionRibbonCommand = 'settings' | 'details' | 'validate' | 'sample' | 'cancel'
export type PredictionRibbonState = Readonly<{
  busy: boolean
  canSample: boolean
  canValidate: boolean
  direction: 'forward' | 'inverse'
  status: string
  sampleDisabledReason?: string
  validateDisabledReason?: string
}>
export type LabRibbonCommand = 'new' | 'end' | 'cancel'
export type MaterialRibbonCommand = 'new' | 'edit' | 'add-name' | 'add-parameter' | 'delete' | 'refresh'

export function useCaePageChrome({
  analysisTab,
  authenticated,
  dataReadable,
  calculationDirty,
  calculationSaveState,
  experimentAuthoringState,
  guardReplacement,
  helpKind,
  materialSelected,
  requestAnalysisCommand,
  requestCalculationSave,
  selectedCalculationId,
  requestLabCommand,
  requestMaterialCommand,
  requestPredictionCommand,
  refreshRuntime,
  requestRunSelected,
  runSafely,
  setActiveSection,
  setAnalysisTab,
  setDialog,
  setHelpKind,
  workbench,
  predictionState,
}: {
  analysisTab: AnalysisTabId
  authenticated: boolean
  dataReadable: boolean
  calculationDirty: boolean
  calculationSaveState: CalculationSaveState
  experimentAuthoringState: CadEditorAuthoringState | null
  guardReplacement: (run: () => unknown | Promise<unknown>) => void
  helpKind: HelpKindId
  materialSelected: boolean
  requestAnalysisCommand: (command: AnalysisRibbonCommand) => void
  requestCalculationSave: () => void
  selectedCalculationId: number | null
  requestLabCommand: (command: LabRibbonCommand) => void
  requestMaterialCommand: (command: MaterialRibbonCommand) => void
  requestPredictionCommand: (command: PredictionRibbonCommand, sampleCount?: number) => void
  refreshRuntime: () => void
  requestRunSelected: () => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setActiveSection: (section: WorkbenchSectionId) => void
  setAnalysisTab: (tab: AnalysisTabId) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  setHelpKind: (kind: HelpKindId) => void
  workbench: CaeWorkbenchState
  predictionState: PredictionRibbonState
}) {
  const [repeatCountInput, setRepeatCountInput] = useState('10')
  const repeatCount = Number(repeatCountInput)
  const repeatCountValid = repeatCountInput.trim() !== '' && Number.isSafeInteger(repeatCount) && repeatCount > 0
  const [samplingCountInput, setSamplingCountInput] = useState('10')
  const samplingCount = Number(samplingCountInput)
  const samplingCountValid =
    samplingCountInput.trim() !== '' && Number.isSafeInteger(samplingCount) && samplingCount > 0
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
    const pendingResultReason = workbench.measurementActions.pendingRecordMeasurementId
      ? '실행 결과 저장을 먼저 다시 시도하세요.'
      : undefined
    const sourceLockReason =
      busyReason ?? pendingResultReason ?? (workbench.saving ? 'Experiment 저장이 진행 중입니다.' : undefined)
    const evaluationBusyReason = workbench.experimentDocument.runIsBusy
      ? 'Experiment 평가가 진행 중입니다.'
      : busyReason
    const candidateEvaluationReason =
      workbench.experimentDocument.status !== 'Ready' ||
      workbench.experimentDocument.successfulRevision !== workbench.experimentDocument.revision ||
      !workbench.experimentDocument.variables ||
      !workbench.experimentDocument.materialParameters
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
        label: 'New',
        icon: <FlaskConical />,
        onSelect: () =>
          guardReplacement(() => {
            workbench.newExperiment(
              starterExperimentSourceBundle,
              'Starter Experiment',
              '로컬에서 즉시 편집할 수 있는 Starter Box Experiment입니다.',
            )
            setActiveSection('experiment')
          }),
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
        id: 'save-experiment',
        label: 'Save',
        icon: <Save />,
        disabled:
          !authenticated ||
          !workbench.experiment ||
          !workbench.experimentSourceValidated ||
          Boolean(workbench.experimentRecord && !workbench.experimentManageable) ||
          (workbench.sourceLocked && workbench.experimentDirty) ||
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : !workbench.experimentSourceValidated
              ? sourceValidationReason
              : workbench.experimentRecord && !workbench.experimentManageable
                ? '다른 사용자의 Experiment는 Save As로 저장하세요.'
                : workbench.sourceLocked && workbench.experimentDirty
                  ? '연결 데이터가 있는 Version은 잠겨 있습니다. Save New Version을 사용하세요.'
                  : sourceLockReason,
        onSelect: () => setDialog('save-experiment'),
      },
      saveExperimentVersion: {
        id: 'save-experiment-version',
        label: 'New Version',
        icon: <GitBranch />,
        disabled:
          !authenticated ||
          !workbench.experimentRecord ||
          !workbench.experimentSourceValidated ||
          !workbench.experimentManageable ||
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentRecord
            ? '먼저 Experiment를 저장하세요.'
            : !workbench.experimentSourceValidated
              ? sourceValidationReason
              : !workbench.experimentManageable
                ? '다른 사용자의 Experiment는 Save As로 저장하세요.'
                : sourceLockReason,
        onSelect: () => setDialog('save-experiment-version'),
      },
      saveExperimentAs: {
        id: 'save-experiment-as',
        label: 'Save As',
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
        onSelect: () => setDialog('save-experiment-as'),
      },
      generateCandidate: {
        id: 'generate-candidate',
        label: 'Candidate',
        icon: <RotateCw />,
        disabled:
          !workbench.experiment ||
          workbench.experimentDocument.runIsBusy ||
          caeBusy ||
          Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        disabledReason: !workbench.experiment
          ? 'Experiment source가 없습니다.'
          : (pendingResultReason ?? evaluationBusyReason),
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
            !workbench.experimentDocument.materialParameters ||
            caeBusy ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId)),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ??
            tasklessReason ??
            (!workbench.experimentClean
              ? savedReason
              : (draftPreviewReason ?? pendingResultReason ?? candidateEvaluationReason ?? evaluationBusyReason))),
        onSelect: () => (authenticated ? runSafely(workbench.measurementActions.saveCurrent) : setDialog('account')),
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
            caeBusy ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId)),
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
                  : (draftPreviewReason ?? pendingResultReason ?? candidateEvaluationReason ?? evaluationBusyReason))),
        onSelect: cancellingCurrentRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(workbench.measurementActions.saveAndRunCurrent) : setDialog('account')),
      },
      saveCalculation: {
        id: 'save-calculation',
        label: 'Save',
        icon: <Save />,
        shortcut: 'Ctrl+S / Cmd+S',
        disabled: authenticated && calculationSaveState.disabled,
        disabledReason: authenticated ? calculationSaveState.disabledReason : loginReason,
        pressed: calculationDirty,
        onSelect: () => (authenticated ? requestCalculationSave() : setDialog('account')),
      },
      cancelCalculationData: {
        id: 'cancel-calculation-data',
        label: 'Cancel Data',
        icon: <Square />,
        onSelect: workbench.measurementActions.automaticCalculationData
          ? workbench.measurementActions.cancel
          : workbench.calculationDataActions.cancel,
      },
      calculateSelectedData: {
        id: 'calculate-selected-data',
        label: 'Selected Calc',
        icon: <Database />,
        disabled:
          authenticated &&
          (Boolean(demoReadOnlyReason) ||
            !workbench.experimentId ||
            selectedCalculationId === null ||
            calculationDirty ||
            caeBusy),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ??
            (!workbench.experimentId
              ? '저장된 Experiment가 필요합니다.'
              : selectedCalculationId === null
                ? '저장된 Calculation을 선택하세요.'
                : calculationDirty
                  ? 'Calculation source를 저장한 뒤 실행하세요.'
                  : busyReason)),
        onSelect: () => {
          if (!authenticated) return setDialog('account')
          if (selectedCalculationId !== null)
            runSafely(() => workbench.calculationDataActions.calculateSelected(selectedCalculationId))
        },
      },
      calculateMeasurementData: {
        id: 'calculate-measurement-data',
        label: 'Selected Measurement',
        icon: <Beaker />,
        disabled:
          authenticated &&
          (Boolean(demoReadOnlyReason) || !workbench.experimentId || !selected?.recorded_at || caeBusy),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ??
            (!workbench.experimentId
              ? '저장된 Experiment가 필요합니다.'
              : !selected?.recorded_at
                ? 'Recorded Measurement를 선택하세요.'
                : busyReason)),
        onSelect: () => {
          if (!authenticated) return setDialog('account')
          if (selected?.recorded_at)
            runSafely(() => workbench.calculationDataActions.calculateMeasurement(selected.id, { announce: true }))
        },
      },
      calculateAllData: {
        id: 'calculate-all-data',
        label: 'All Missing',
        icon: <SaveAll />,
        disabled: authenticated && (Boolean(demoReadOnlyReason) || !workbench.experimentId || caeBusy),
        disabledReason: !authenticated
          ? loginReason
          : (demoReadOnlyReason ?? (!workbench.experimentId ? '저장된 Experiment가 필요합니다.' : busyReason)),
        onSelect: () =>
          authenticated ? runSafely(workbench.calculationDataActions.calculateAll) : setDialog('account'),
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
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
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
                    : (draftPreviewReason ?? pendingResultReason ?? evaluationBusyReason ?? sourceLockReason))))),
        onSelect: cancellingGeneratedRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(workbench.measurementActions.generateAndRun) : setDialog('account')),
      },
      repeatGenerateAndRun: {
        id: 'repeat-generate-and-run',
        label: cancellingRepeatRun ? 'Cancel' : 'Repeat Run',
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
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
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
                      : (draftPreviewReason ?? pendingResultReason ?? evaluationBusyReason ?? sourceLockReason))))),
        onSelect: cancellingRepeatRun
          ? workbench.measurementActions.cancel
          : () =>
              authenticated
                ? runSafely(() => workbench.measurementActions.repeatGenerateAndRun(repeatCount))
                : setDialog('account'),
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
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
            !workbench.simulation.canRun ||
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
                    : (pendingResultReason ?? draftPreviewReason ?? evaluationBusyReason))),
        onSelect: cancellingSelectedRun
          ? workbench.measurementActions.cancel
          : () => (authenticated ? runSafely(requestRunSelected) : setDialog('account')),
      },
      retryRecord: {
        id: 'retry-record',
        label: 'Retry Save',
        icon: <Save />,
        disabled: !workbench.measurementActions.pendingRecordMeasurementId || caeBusy,
        disabledReason: !workbench.measurementActions.pendingRecordMeasurementId
          ? '다시 저장할 session 결과가 없습니다.'
          : busyReason,
        onSelect: () => runSafely(workbench.measurementActions.retryRecord),
      },
      analyzeMeasurements: {
        id: 'analyze-measurements',
        label: 'Analysis',
        icon: <ChartNoAxesCombined />,
        disabled: !dataReadable || (authenticated && !workbench.experimentClean),
        disabledReason: !dataReadable ? loginReason : !workbench.experimentClean ? savedReason : undefined,
        onSelect: () => setActiveSection('analysis'),
      },
      materialNew: {
        id: 'material-new',
        label: 'New',
        icon: <Plus />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestMaterialCommand('new'),
      },
      materialEdit: {
        id: 'material-edit',
        label: 'Edit',
        icon: <Pencil />,
        disabled: !authenticated || !materialSelected,
        disabledReason: !authenticated ? loginReason : !materialSelected ? 'Material을 선택하세요.' : undefined,
        onSelect: () => requestMaterialCommand('edit'),
      },
      materialName: {
        id: 'material-name',
        label: 'Add Name',
        icon: <Plus />,
        disabled: !authenticated || !materialSelected,
        disabledReason: !authenticated ? loginReason : !materialSelected ? 'Material을 선택하세요.' : undefined,
        onSelect: () => requestMaterialCommand('add-name'),
      },
      materialParameter: {
        id: 'material-parameter',
        label: 'Add Parameter',
        icon: <Database />,
        disabled: !authenticated || !materialSelected,
        disabledReason: !authenticated ? loginReason : !materialSelected ? 'Material을 선택하세요.' : undefined,
        onSelect: () => requestMaterialCommand('add-parameter'),
      },
      materialDelete: {
        id: 'material-delete',
        label: 'Delete',
        icon: <Trash2 />,
        disabled: !authenticated || !materialSelected,
        disabledReason: !authenticated ? loginReason : !materialSelected ? 'Material을 선택하세요.' : undefined,
        onSelect: () => requestMaterialCommand('delete'),
      },
      materialRefresh: {
        id: 'material-refresh',
        label: 'Refresh',
        icon: <RefreshCw />,
        onSelect: () => requestMaterialCommand('refresh'),
      },
      account: { id: 'account', label: 'Account', icon: <CircleUserRound />, onSelect: () => setDialog('account') },
      labChat: {
        id: 'lab-chat',
        label: 'AI Chat',
        icon: <MessageCircle />,
        pressed: true,
        onSelect: () => setActiveSection('lab'),
      },
      labNew: {
        id: 'lab-new',
        label: 'New Chat',
        icon: <Plus />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestLabCommand('new'),
      },
      labEnd: {
        id: 'lab-end',
        label: 'End',
        icon: <Square />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestLabCommand('end'),
      },
      labCancel: {
        id: 'lab-cancel',
        label: 'Cancel',
        icon: <Trash2 />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestLabCommand('cancel'),
      },
      analysisReload: {
        id: 'analysis-reload',
        label: 'Reload',
        icon: <RefreshCw />,
        disabled: !dataReadable,
        disabledReason: !dataReadable ? '먼저 공개 Demo 또는 내 Experiment를 여세요.' : undefined,
        onSelect: () => requestAnalysisCommand('reload'),
      },
      analysisDataset: {
        id: 'analysis-dataset',
        label: 'Data CSV',
        icon: <Download />,
        disabled: !dataReadable,
        disabledReason: !dataReadable ? '먼저 공개 Demo 또는 내 Experiment를 여세요.' : undefined,
        onSelect: () => requestAnalysisCommand('export-dataset'),
      },
      predictionSettings: {
        id: 'prediction-settings',
        label: 'Prediction Settings',
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
        onSelect: () => (authenticated ? requestPredictionCommand('validate') : setDialog('account')),
      },
      predictionSample: {
        id: 'prediction-sample',
        label: 'Sample & Run',
        icon: <Sparkles />,
        disabled: authenticated && (!samplingCountValid || !predictionState.canSample),
        disabledReason: authenticated
          ? !samplingCountValid
            ? 'N은 양의 JavaScript safe integer여야 합니다.'
            : predictionState.sampleDisabledReason
          : '로그인하여 sampling Measurement를 저장하세요.',
        onSelect: () => (authenticated ? requestPredictionCommand('sample', samplingCount) : setDialog('account')),
      },
      predictionCancel: {
        id: 'prediction-cancel',
        label: 'Cancel',
        icon: <Square />,
        onSelect: () => requestPredictionCommand('cancel'),
      },
      settingRefresh: { id: 'setting-refresh', label: 'Refresh', icon: <RefreshCw />, onSelect: refreshRuntime },
    }

    if (!sourceLockReason) return defined
    const locked = new Set(['newExperiment', 'saveExperiment', 'saveExperimentVersion', 'saveExperimentAs'])
    return Object.fromEntries(
      Object.entries(defined).map(([key, action]) => [
        key,
        locked.has(key) ? { ...action, disabled: true, disabledReason: sourceLockReason } : action,
      ]),
    )
  }, [
    authenticated,
    dataReadable,
    calculationDirty,
    calculationSaveState,
    guardReplacement,
    materialSelected,
    requestAnalysisCommand,
    requestCalculationSave,
    requestLabCommand,
    requestMaterialCommand,
    requestPredictionCommand,
    refreshRuntime,
    requestRunSelected,
    repeatCount,
    repeatCountValid,
    runSafely,
    setActiveSection,
    setDialog,
    predictionState,
    workbench,
  ])

  const analysisActions = (['explore', 'mining', 'data'] as const).map((tab) => ({
    id: `analysis-${tab}`,
    label: tab[0].toUpperCase() + tab.slice(1),
    icon: tab === 'mining' ? <Sparkles /> : <ChartNoAxesCombined />,
    pressed: analysisTab === tab,
    onSelect: () => setAnalysisTab(tab),
  }))
  const helpActions: readonly WorkbenchAction[] = [
    {
      id: 'help-manual',
      label: 'Manual',
      icon: <BookOpenText />,
      pressed: helpKind === 'manual',
      onSelect: () => setHelpKind('manual'),
    },
    {
      id: 'help-geometry',
      label: 'Geometry',
      icon: <Boxes />,
      pressed: helpKind === 'geometry',
      onSelect: () => setHelpKind('geometry'),
    },
    {
      id: 'help-materials',
      label: 'Material',
      icon: <Layers3 />,
      pressed: helpKind === 'materials',
      onSelect: () => setHelpKind('materials'),
    },
    {
      id: 'help-quantity',
      label: 'Quantity',
      icon: <Gauge />,
      pressed: helpKind === 'quantity-kinds',
      onSelect: () => setHelpKind('quantity-kinds'),
    },
    {
      id: 'help-solvers',
      label: 'Solvers',
      icon: <FlaskConical />,
      pressed: helpKind === 'solvers',
      onSelect: () => setHelpKind('solvers'),
    },
  ]

  const ribbonPanels: readonly WorkbenchRibbonPanel[] = [
    {
      sectionId: 'experiment',
      label: 'Experiment',
      content: (
        <>
          <WorkbenchRibbonGroup label="File">
            <WorkbenchRibbonActions
              actions={[
                actions.newExperiment,
                ...(workbench.experimentIsDemo ? [actions.editDemoCopy] : []),
                actions.saveExperiment,
                actions.saveExperimentVersion,
                actions.saveExperimentAs,
              ]}
            />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Candidate">
            <WorkbenchRibbonActions actions={[actions.generateCandidate, actions.saveCurrentMeasurement]} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Geometry">
            <GeometryAuthoringRibbon state={experimentAuthoringState} />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'measurement',
      label: 'Calculation',
      content: (
        <>
          <WorkbenchRibbonGroup label="Calculation">
            <WorkbenchRibbonActions actions={[actions.saveCalculation]} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Calculation Data">
            <WorkbenchRibbonActions
              actions={
                workbench.calculationDataActions.busy
                  ? [actions.cancelCalculationData]
                  : [actions.calculateSelectedData, actions.calculateMeasurementData, actions.calculateAllData]
              }
            />
            {workbench.calculationDataActions.progress?.running ? (
              <div className="flex h-[68px] max-w-36 flex-col justify-center text-[10px] text-muted-foreground">
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
          <WorkbenchRibbonGroup label="Measurement">
            <WorkbenchRibbonActions actions={[actions.generateCandidate, actions.saveCurrentMeasurement]} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Run">
            <WorkbenchRibbonActions actions={[actions.saveAndRunCurrent, actions.generateAndRun]} />
            <label className="flex h-[68px] w-16 shrink-0 flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
              <input
                aria-label="Repeat Run 횟수"
                aria-invalid={!repeatCountValid}
                className="h-7 w-14 rounded border border-border bg-background px-1 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={workbench.measurementActions.busy || workbench.calculationDataActions.busy}
                min="1"
                step="1"
                type="number"
                value={repeatCountInput}
                onChange={(event) => setRepeatCountInput(event.target.value)}
              />
              <span>Times</span>
            </label>
            <WorkbenchRibbonActions
              actions={[
                actions.repeatGenerateAndRun,
                actions.runSelected,
                ...(workbench.measurementActions.pendingRecordMeasurementId ? [actions.retryRecord] : []),
                actions.analyzeMeasurements,
              ]}
            />
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
          <WorkbenchRibbonGroup label="Direction">
            <div className="flex h-[68px] min-w-36 flex-col justify-center px-2 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground capitalize">{predictionState.direction}</span>
              <span className="max-w-48 truncate" title={predictionState.status}>
                {predictionState.status}
              </span>
            </div>
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Validation">
            <WorkbenchRibbonActions
              actions={predictionState.busy ? [actions.predictionCancel] : [actions.predictionValidate]}
            />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Sampling">
            <label className="flex h-[68px] w-16 shrink-0 flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
              <input
                aria-label="Sample & Run 횟수"
                aria-invalid={!samplingCountValid}
                className="h-7 w-14 rounded border border-border bg-background px-1 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={predictionState.busy}
                min="1"
                step="1"
                type="number"
                value={samplingCountInput}
                onChange={(event) => setSamplingCountInput(event.target.value)}
              />
              <span>Times</span>
            </label>
            <WorkbenchRibbonActions actions={predictionState.busy ? [] : [actions.predictionSample]} />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'material',
      label: 'Material',
      content: (
        <WorkbenchRibbonGroup label="Material">
          <WorkbenchRibbonActions
            actions={[
              actions.materialNew,
              actions.materialEdit,
              actions.materialName,
              actions.materialParameter,
              actions.materialDelete,
              actions.materialRefresh,
            ]}
          />
        </WorkbenchRibbonGroup>
      ),
    },
    {
      sectionId: 'analysis',
      label: 'Analysis',
      content: (
        <>
          <WorkbenchRibbonGroup label="View">
            <WorkbenchRibbonActions actions={analysisActions} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Data">
            <WorkbenchRibbonActions actions={[actions.analysisReload, actions.analysisDataset]} />
          </WorkbenchRibbonGroup>
        </>
      ),
    },
    {
      sectionId: 'lab',
      label: 'Lab',
      content: (
        <WorkbenchRibbonGroup label="AI Chat">
          <WorkbenchRibbonActions actions={[actions.labChat, actions.labNew, actions.labEnd, actions.labCancel]} />
        </WorkbenchRibbonGroup>
      ),
    },
    {
      sectionId: 'help',
      label: 'Help',
      content: (
        <WorkbenchRibbonGroup label="Manual & Catalog">
          <WorkbenchRibbonActions actions={helpActions} />
        </WorkbenchRibbonGroup>
      ),
    },
    {
      sectionId: 'setting',
      label: 'Setting',
      content: (
        <WorkbenchRibbonGroup label="Runtime & Account">
          <WorkbenchRibbonActions actions={[actions.account, actions.settingRefresh]} />
        </WorkbenchRibbonGroup>
      ),
    },
  ]

  return { actions, ribbonPanels }
}
