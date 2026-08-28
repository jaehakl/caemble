import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import {
  Beaker,
  BookOpenText,
  Boxes,
  BrainCircuit,
  ChartNoAxesCombined,
  CircleUserRound,
  Database,
  Download,
  FlaskConical,
  Gauge,
  GitBranch,
  Layers3,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCw,
  Save,
  SaveAll,
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
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, HelpKindId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import type { WorkbenchDialog } from './caePageTypes'
import { GeometryAuthoringRibbon } from './GeometryAuthoringRibbon'

export type AnalysisRibbonCommand = 'reload' | 'export-dataset' | 'export-prediction'
export type LabRibbonCommand = 'new' | 'end' | 'cancel'
export type MaterialRibbonCommand = 'new' | 'edit' | 'add-name' | 'add-parameter' | 'delete' | 'refresh'

export function useCaePageChrome({
  analysisTab,
  authenticated,
  experimentAuthoringState,
  guardReplacement,
  helpKind,
  materialSelected,
  requestAnalysisCommand,
  requestLabCommand,
  requestMaterialCommand,
  refreshRuntime,
  requestRunSelected,
  runSafely,
  setActiveSection,
  setAnalysisTab,
  setDialog,
  setHelpKind,
  workbench,
}: {
  analysisTab: AnalysisTabId
  authenticated: boolean
  experimentAuthoringState: CadEditorAuthoringState | null
  guardReplacement: (run: () => unknown | Promise<unknown>) => void
  helpKind: HelpKindId
  materialSelected: boolean
  requestAnalysisCommand: (command: AnalysisRibbonCommand) => void
  requestLabCommand: (command: LabRibbonCommand) => void
  requestMaterialCommand: (command: MaterialRibbonCommand) => void
  refreshRuntime: () => void
  requestRunSelected: () => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setActiveSection: (section: WorkbenchSectionId) => void
  setAnalysisTab: (tab: AnalysisTabId) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  setHelpKind: (kind: HelpKindId) => void
  workbench: CaeWorkbenchState
}) {
  const [repeatCountInput, setRepeatCountInput] = useState('10')
  const repeatCount = Number(repeatCountInput)
  const repeatCountValid = repeatCountInput.trim() !== '' && Number.isSafeInteger(repeatCount) && repeatCount > 0
  const actions = useMemo<Record<string, WorkbenchAction>>(() => {
    const loginReason = '로그인 후 사용할 수 있습니다.'
    const savedReason = '저장되고 편집되지 않은 Experiment가 필요합니다.'
    const sourceValidationReason = 'Experiment source 오류를 수정하고 의미 검사를 완료한 뒤 저장하세요.'
    const tasklessReason = !workbench.hasTasks
      ? 'Task가 없는 Experiment는 미리보기와 source 저장만 사용할 수 있습니다.'
      : undefined
    const busyReason = workbench.measurementActions.busy ? '다른 CAE 작업이 진행 중입니다.' : undefined
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
          workbench.measurementActions.busy ||
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
          !authenticated ||
          !workbench.hasTasks ||
          !workbench.experimentClean ||
          workbench.experimentDocument.draftTaskNames.length > 0 ||
          workbench.experimentDocument.status !== 'Ready' ||
          workbench.experimentDocument.successfulRevision !== workbench.experimentDocument.revision ||
          !workbench.experimentDocument.variables ||
          !workbench.experimentDocument.materialParameters ||
          workbench.measurementActions.busy ||
          Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        disabledReason: !authenticated
          ? loginReason
          : (tasklessReason ??
            (!workbench.experimentClean
              ? savedReason
              : (draftPreviewReason ?? pendingResultReason ?? candidateEvaluationReason ?? evaluationBusyReason))),
        onSelect: () => runSafely(workbench.measurementActions.saveCurrent),
      },
      generateAndRun: {
        id: 'generate-and-run',
        label: cancellingGeneratedRun ? 'Cancel' : 'Generate & Run',
        icon: cancellingGeneratedRun ? <Square /> : <Rocket />,
        disabled:
          !cancellingGeneratedRun &&
          (!authenticated ||
            !workbench.experiment ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            workbench.experimentDocument.runIsBusy ||
            workbench.measurementActions.busy ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
            workbench.saving !== null),
        disabledReason: cancellingGeneratedRun
          ? undefined
          : !authenticated
            ? loginReason
            : !workbench.experiment
              ? 'Experiment source가 없습니다.'
              : (tasklessReason ??
                (!workbench.experimentClean
                  ? savedReason
                  : (draftPreviewReason ?? pendingResultReason ?? evaluationBusyReason ?? sourceLockReason))),
        onSelect: cancellingGeneratedRun
          ? workbench.measurementActions.cancel
          : () => runSafely(workbench.measurementActions.generateAndRun),
      },
      repeatGenerateAndRun: {
        id: 'repeat-generate-and-run',
        label: cancellingRepeatRun ? 'Cancel' : 'Repeat Run',
        icon: cancellingRepeatRun ? <Square /> : <RefreshCw />,
        disabled:
          !cancellingRepeatRun &&
          (!repeatCountValid ||
            !authenticated ||
            !workbench.experiment ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            workbench.experimentDocument.draftTaskNames.length > 0 ||
            workbench.experimentDocument.runIsBusy ||
            workbench.measurementActions.busy ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
            workbench.saving !== null),
        disabledReason: cancellingRepeatRun
          ? undefined
          : !repeatCountValid
            ? '반복 횟수는 양의 정수여야 합니다.'
            : !authenticated
              ? loginReason
              : !workbench.experiment
                ? 'Experiment source가 없습니다.'
                : (tasklessReason ??
                  (!workbench.experimentClean
                    ? savedReason
                    : (draftPreviewReason ?? pendingResultReason ?? evaluationBusyReason ?? sourceLockReason))),
        onSelect: cancellingRepeatRun
          ? workbench.measurementActions.cancel
          : () => runSafely(() => workbench.measurementActions.repeatGenerateAndRun(repeatCount)),
      },
      runSelected: {
        id: 'run-selected',
        label: cancellingSelectedRun ? 'Cancel' : 'Run',
        icon: cancellingSelectedRun ? <Square /> : <Play />,
        disabled:
          !cancellingSelectedRun &&
          (!authenticated ||
            !workbench.hasTasks ||
            !workbench.experimentClean ||
            !selected ||
            Boolean(selected?.recorded_at) ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
            !workbench.simulation.canRun ||
            workbench.measurementActions.busy),
        disabledReason: cancellingSelectedRun
          ? undefined
          : !authenticated
            ? loginReason
            : (tasklessReason ??
              (!workbench.experimentClean
                ? savedReason
                : !selected
                  ? 'Prepared Measurement를 선택하세요.'
                  : selected.recorded_at
                    ? 'Recorded Measurement는 다시 실행할 수 없습니다.'
                    : (pendingResultReason ?? draftPreviewReason ?? evaluationBusyReason))),
        onSelect: cancellingSelectedRun ? workbench.measurementActions.cancel : () => runSafely(requestRunSelected),
      },
      retryRecord: {
        id: 'retry-record',
        label: 'Retry Save',
        icon: <Save />,
        disabled: !workbench.measurementActions.pendingRecordMeasurementId || workbench.measurementActions.busy,
        disabledReason: !workbench.measurementActions.pendingRecordMeasurementId
          ? '다시 저장할 session 결과가 없습니다.'
          : busyReason,
        onSelect: () => runSafely(workbench.measurementActions.retryRecord),
      },
      analyzeMeasurements: {
        id: 'analyze-measurements',
        label: 'Analysis',
        icon: <ChartNoAxesCombined />,
        disabled: !authenticated || !workbench.experimentClean,
        disabledReason: !authenticated ? loginReason : !workbench.experimentClean ? savedReason : undefined,
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
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestAnalysisCommand('reload'),
      },
      analysisDataset: {
        id: 'analysis-dataset',
        label: 'Data CSV',
        icon: <Download />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestAnalysisCommand('export-dataset'),
      },
      analysisPrediction: {
        id: 'analysis-prediction',
        label: 'Prediction CSV',
        icon: <Download />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => requestAnalysisCommand('export-prediction'),
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
    guardReplacement,
    materialSelected,
    requestAnalysisCommand,
    requestLabCommand,
    requestMaterialCommand,
    refreshRuntime,
    requestRunSelected,
    repeatCount,
    repeatCountValid,
    runSafely,
    setActiveSection,
    setDialog,
    workbench,
  ])

  const analysisActions = (['explore', 'mining', 'prediction', 'data'] as const).map((tab) => ({
    id: `analysis-${tab}`,
    label: tab[0].toUpperCase() + tab.slice(1),
    icon: tab === 'prediction' ? <BrainCircuit /> : tab === 'mining' ? <Sparkles /> : <ChartNoAxesCombined />,
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
          <WorkbenchRibbonGroup label="Measurement">
            <WorkbenchRibbonActions actions={[actions.generateCandidate, actions.saveCurrentMeasurement]} />
          </WorkbenchRibbonGroup>
          <WorkbenchRibbonGroup label="Run">
            <WorkbenchRibbonActions actions={[actions.generateAndRun]} />
            <label className="flex h-[68px] w-16 shrink-0 flex-col items-center justify-center gap-1 text-[10px] text-muted-foreground">
              <input
                aria-label="Repeat Run 횟수"
                aria-invalid={!repeatCountValid}
                className="h-7 w-14 rounded border border-border bg-background px-1 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={workbench.measurementActions.busy}
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
            <WorkbenchRibbonActions
              actions={[actions.analysisReload, actions.analysisDataset, actions.analysisPrediction]}
            />
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
