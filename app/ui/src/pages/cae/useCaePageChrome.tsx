import { useMemo, type Dispatch, type SetStateAction } from 'react'
import {
  Beaker,
  Bot,
  BookOpenText,
  Boxes,
  ChartNoAxesCombined,
  CircleUserRound,
  Copy,
  Database,
  FlaskConical,
  FolderOpen,
  Gauge,
  GitBranch,
  Layers3,
  ListChecks,
  MessageCircle,
  Play,
  RotateCw,
  Save,
  SaveAll,
  Server,
  Square,
  TableProperties,
  Upload,
} from 'lucide-react'
import type { WorkbenchAction, WorkbenchMenuDefinition } from '@/features/cae-workbench/chrome'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { WorkbenchDialog } from './caePageTypes'
import { GeometryAuthoringRibbon } from './GeometryAuthoringRibbon'
import { RibbonActions } from './RibbonActions'

function openDocsWindow(href: string) {
  window.open(href, '_blank', 'noopener,noreferrer')
}

export function useCaePageChrome({
  authenticated,
  experimentAuthoringState,
  geometryAuthoringState,
  openTab,
  requestRunSelected,
  runSafely,
  setDialog,
  workbench,
}: {
  authenticated: boolean
  experimentAuthoringState: CadEditorAuthoringState | null
  geometryAuthoringState: CadEditorAuthoringState | null
  openTab: (tab: WorkbenchTabId) => void
  requestRunSelected: () => void
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const actions = useMemo<Record<string, WorkbenchAction>>(() => {
    const loginReason = '로그인 후 사용할 수 있습니다.'
    const savedReason = '저장되고 편집되지 않은 Experiment가 필요합니다.'
    const geometryDraftReason = workbench.geometryLocalDraftDirty
      ? 'Geometry local draft를 Publish & Apply하거나 폐기해야 합니다.'
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
    const draftPreviewReason =
      workbench.experimentDocument.draftTaskNames.length > 0
        ? 'Solver가 선택되지 않은 Draft Task가 있어 Measurement 저장과 CAE 실행을 사용할 수 없습니다.'
        : undefined
    const selected = workbench.selection.measurement
    const cancellingRun =
      workbench.measurementActions.operation === 'measurement' && workbench.measurementActions.cancelable

    const defined: Record<string, WorkbenchAction> = {
      newExperiment: {
        id: 'new-experiment',
        label: 'New Experiment',
        icon: <FlaskConical className="size-4" />,
        onSelect: () => setDialog('new-experiment'),
      },
      loadExperiment: {
        id: 'load-experiment',
        label: 'Load Experiment',
        icon: <FolderOpen className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('load-experiment'),
      },
      experimentHistory: {
        id: 'experiment-history',
        label: 'Experiment History',
        icon: <GitBranch className="size-4" />,
        disabled: !authenticated || !workbench.experimentId,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentId
            ? '저장된 Experiment가 필요합니다.'
            : undefined,
        onSelect: () => setDialog('experiment-history'),
      },
      saveExperiment: {
        id: 'save-experiment',
        label: 'Save Experiment',
        icon: <Save className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.experiment ||
          Boolean(workbench.experimentRecord && !workbench.experimentManageable) ||
          workbench.geometryLocalDraftDirty ||
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : workbench.experimentRecord && !workbench.experimentManageable
              ? '다른 사용자의 정의는 Save As로 저장하세요.'
              : (geometryDraftReason ?? sourceLockReason),
        onSelect: () => setDialog('save-experiment'),
      },
      saveExperimentAs: {
        id: 'save-experiment-as',
        label: 'Save Experiment As',
        icon: <SaveAll className="size-4" />,
        disabled:
          !authenticated || !workbench.experiment || workbench.geometryLocalDraftDirty || workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : (geometryDraftReason ?? sourceLockReason),
        onSelect: () => setDialog('save-experiment-as'),
      },
      generateCandidate: {
        id: 'generate-candidate',
        label: 'Generate Candidate',
        icon: <RotateCw className="size-4" />,
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
        label: 'Save Current Measurement',
        icon: <Beaker className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.experimentClean ||
          workbench.experimentDocument.draftTaskNames.length > 0 ||
          workbench.experimentDocument.status !== 'Ready' ||
          !workbench.experimentDocument.variables ||
          !workbench.experimentDocument.materialParameters ||
          workbench.measurementActions.busy ||
          Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentClean
            ? savedReason
            : (draftPreviewReason ?? pendingResultReason ?? evaluationBusyReason),
        onSelect: () => runSafely(workbench.measurementActions.saveCurrent),
      },
      selectMeasurement: {
        id: 'select-measurement',
        label: 'Select Measurement',
        icon: <TableProperties className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.experimentClean ||
          workbench.measurementActions.busy ||
          Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentClean
            ? savedReason
            : (pendingResultReason ?? busyReason),
        onSelect: () => setDialog('measurement'),
      },
      duplicateMeasurement: {
        id: 'duplicate-measurement',
        label: 'Duplicate Measurement',
        icon: <Copy className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.experimentClean ||
          !selected ||
          workbench.experimentDocument.draftTaskNames.length > 0 ||
          workbench.measurementActions.busy ||
          Boolean(workbench.measurementActions.pendingRecordMeasurementId),
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentClean
            ? savedReason
            : !selected
              ? '복제할 Measurement를 선택하세요.'
              : (draftPreviewReason ?? pendingResultReason ?? busyReason),
        onSelect: () => {
          if (selected) runSafely(() => workbench.measurementActions.duplicateMeasurement(selected))
        },
      },
      runSelected: {
        id: 'run-selected',
        label: cancellingRun ? 'Cancel Run' : 'Run Selected',
        icon: cancellingRun ? <Square className="size-4" /> : <Play className="size-4" />,
        disabled:
          !cancellingRun &&
          (!authenticated ||
            !workbench.experimentClean ||
            !selected ||
            Boolean(selected?.recorded_at) ||
            Boolean(workbench.measurementActions.pendingRecordMeasurementId) ||
            !workbench.simulation.canRun ||
            workbench.measurementActions.busy),
        disabledReason: cancellingRun
          ? undefined
          : !authenticated
            ? loginReason
            : !workbench.experimentClean
              ? savedReason
              : !selected
                ? 'Prepared Measurement를 선택하세요.'
                : selected.recorded_at
                  ? '이미 RecordedData가 있는 Measurement는 다시 실행할 수 없습니다.'
                  : workbench.measurementActions.pendingRecordMeasurementId
                    ? '실행 결과 저장을 먼저 다시 시도하세요.'
                    : (draftPreviewReason ?? evaluationBusyReason),
        onSelect: cancellingRun ? workbench.measurementActions.cancel : () => runSafely(requestRunSelected),
      },
      retryRecord: {
        id: 'retry-record',
        label: 'Retry Saving Results',
        icon: <Save className="size-4" />,
        disabled: !workbench.measurementActions.pendingRecordMeasurementId || workbench.measurementActions.busy,
        disabledReason: !workbench.measurementActions.pendingRecordMeasurementId
          ? '다시 저장할 session 결과가 없습니다.'
          : busyReason,
        onSelect: () => runSafely(workbench.measurementActions.retryRecord),
      },
      analyzeMeasurements: {
        id: 'analyze-measurements',
        label: 'Analyze Measurements',
        icon: <ChartNoAxesCombined className="size-4" />,
        disabled: !authenticated || !workbench.experimentClean,
        disabledReason: !authenticated ? loginReason : !workbench.experimentClean ? savedReason : undefined,
        onSelect: () => setDialog('analysis'),
      },
      experimentTab: {
        id: 'tab-experiment',
        label: 'Experiment Editor',
        icon: <FlaskConical className="size-4" />,
        onSelect: () => openTab('experiment'),
      },
      recordedDataTab: {
        id: 'tab-recorded-data',
        label: 'RecordedData',
        icon: <ChartNoAxesCombined className="size-4" />,
        onSelect: () => openTab('recorded-data'),
      },
      geometryTab: {
        id: 'tab-geometry',
        label: 'Geometry Workspace',
        icon: <Boxes className="size-4" />,
        onSelect: () => openTab('geometry'),
      },
      materialManager: {
        id: 'material-manager',
        label: 'Material Manager',
        icon: <Database className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('material'),
      },
      geometryManager: {
        id: 'geometry-manager',
        label: 'Geometry Manager',
        icon: <Boxes className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('geometry-manager'),
      },
      publishGeometryExport: {
        id: 'publish-geometry-export',
        label: 'Publish geometry.tsx Export',
        icon: <Upload className="size-4" />,
        disabled: !authenticated || workbench.geometry.entryExports.length === 0 || workbench.geometry.busy,
        disabledReason: !authenticated
          ? loginReason
          : workbench.geometry.entryExports.length === 0
            ? 'geometry.tsx에 분석 가능한 named Geometry export가 없습니다.'
            : workbench.geometry.busy
              ? '다른 Geometry 작업이 진행 중입니다.'
              : undefined,
        onSelect: () => setDialog('publish-geometry-export'),
      },
      aiChat: {
        id: 'ai-chat',
        label: 'AI Chat',
        icon: <MessageCircle className="size-4" />,
        onSelect: () => setDialog('ai-chat'),
      },
      aiHelper: {
        id: 'ai-helper',
        label: 'AI Helper',
        icon: <Bot className="size-4" />,
        onSelect: () => openTab('ai-helper'),
      },
      launchers: {
        id: 'launchers',
        label: 'Launchers',
        icon: <Server className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('launchers'),
      },
      jobs: {
        id: 'jobs',
        label: 'Jobs',
        icon: <ListChecks className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('jobs'),
      },
      account: {
        id: 'account',
        label: 'Account',
        icon: <CircleUserRound className="size-4" />,
        onSelect: () => setDialog('account'),
      },
      manual: {
        id: 'manual',
        label: 'Manual',
        icon: <BookOpenText className="size-4" />,
        onSelect: () => openDocsWindow('/docs?section=program'),
      },
      geometryCatalog: {
        id: 'geometry-catalog',
        label: 'Geometry Catalog',
        icon: <Boxes className="size-4" />,
        onSelect: () => openDocsWindow('/docs?section=geometry'),
      },
      materialCatalog: {
        id: 'material-catalog',
        label: 'Material Catalog',
        icon: <Layers3 className="size-4" />,
        onSelect: () => openDocsWindow('/docs?section=materials'),
      },
      quantityCatalog: {
        id: 'quantity-catalog',
        label: 'Quantity Catalog',
        icon: <Gauge className="size-4" />,
        onSelect: () => openDocsWindow('/docs?section=quantity-kinds'),
      },
      physicsCatalog: {
        id: 'physics-catalog',
        label: 'Physics Catalog',
        icon: <FlaskConical className="size-4" />,
        onSelect: () => openDocsWindow('/docs?section=solvers'),
      },
    }

    if (!sourceLockReason) return defined
    const locked = ['newExperiment', 'loadExperiment', 'experimentHistory', 'saveExperiment', 'saveExperimentAs']
    return Object.fromEntries(
      Object.entries(defined).map(([key, action]) => [
        key,
        locked.includes(key) ? { ...action, disabled: true, disabledReason: sourceLockReason } : action,
      ]),
    )
  }, [authenticated, openTab, requestRunSelected, runSafely, setDialog, workbench])

  const menus = useMemo<readonly WorkbenchMenuDefinition[]>(
    () => [
      {
        id: 'source',
        label: 'Source',
        items: [
          { type: 'action', action: actions.newExperiment },
          { type: 'action', action: actions.loadExperiment },
          { type: 'action', action: actions.experimentHistory },
          { type: 'separator', id: 'source-save-separator' },
          { type: 'action', action: actions.saveExperiment },
          { type: 'action', action: actions.saveExperimentAs },
          { type: 'separator', id: 'material-separator' },
          { type: 'action', action: actions.publishGeometryExport },
          { type: 'action', action: actions.geometryManager },
          { type: 'action', action: actions.materialManager },
        ],
      },
      {
        id: 'data',
        label: 'Data',
        items: [
          { type: 'action', action: actions.saveCurrentMeasurement },
          { type: 'action', action: actions.selectMeasurement },
          { type: 'action', action: actions.duplicateMeasurement },
          { type: 'separator', id: 'run-separator' },
          { type: 'action', action: actions.runSelected },
          ...(workbench.measurementActions.pendingRecordMeasurementId
            ? ([{ type: 'action', action: actions.retryRecord }] as const)
            : []),
          { type: 'action', action: actions.analyzeMeasurements },
        ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          { type: 'action', action: actions.experimentTab },
          { type: 'action', action: actions.geometryTab },
          { type: 'action', action: actions.recordedDataTab },
        ],
      },
      { id: 'lab', label: 'Lab', items: [{ type: 'action', action: actions.aiChat }] },
      {
        id: 'settings',
        label: 'Settings',
        items: [
          { type: 'action', action: actions.launchers },
          { type: 'action', action: actions.jobs },
          { type: 'separator', id: 'account-separator' },
          { type: 'action', action: actions.account },
        ],
      },
      {
        id: 'help',
        label: 'Help',
        items: [
          { type: 'action', action: actions.aiHelper },
          { type: 'separator', id: 'ai-helper-separator' },
          { type: 'action', action: actions.manual },
          { type: 'separator', id: 'catalog-separator' },
          { type: 'action', action: actions.geometryCatalog },
          { type: 'action', action: actions.materialCatalog },
          { type: 'action', action: actions.quantityCatalog },
          { type: 'action', action: actions.physicsCatalog },
        ],
      },
    ],
    [actions, workbench.measurementActions.pendingRecordMeasurementId],
  )

  const toolbar = [
    actions.newExperiment,
    actions.loadExperiment,
    actions.saveExperiment,
    actions.generateCandidate,
    actions.saveCurrentMeasurement,
    actions.selectMeasurement,
    actions.runSelected,
    ...(workbench.measurementActions.pendingRecordMeasurementId ? [actions.retryRecord] : []),
    actions.jobs,
  ]

  const ribbonPanels = [
    {
      tabId: 'experiment',
      label: 'Experiment',
      content: (
        <RibbonActions
          actions={[
            actions.newExperiment,
            actions.loadExperiment,
            actions.experimentHistory,
            actions.saveExperiment,
            actions.saveExperimentAs,
            actions.generateCandidate,
            actions.saveCurrentMeasurement,
          ]}
          extraActions={<GeometryAuthoringRibbon state={experimentAuthoringState} />}
        >
          <span className="truncate text-sm font-semibold">{workbench.experimentName}</span>
          <span className="mt-1 text-xs text-muted-foreground">
            {workbench.experimentId ? `#${workbench.experimentId}` : 'DB에 저장되지 않음'} ·{' '}
            {workbench.experimentStatus}
          </span>
        </RibbonActions>
      ),
    },
    {
      tabId: 'geometry',
      label: 'Geometry',
      content: (
        <RibbonActions
          actions={[actions.publishGeometryExport, actions.geometryManager]}
          extraActions={<GeometryAuthoringRibbon state={geometryAuthoringState} />}
        >
          <span className="text-sm font-semibold">Geometry modules</span>
          <span className="mt-1 text-xs text-muted-foreground">
            {workbench.geometryLocalDraftDirty
              ? `${Object.keys(workbench.geometry.drafts).length} local draft · Simulation/영구 저장 차단`
              : workbench.geometryGraphDirty
                ? 'Published graph 변경 · Experiment 저장 필요'
                : 'Exact published graph'}
          </span>
        </RibbonActions>
      ),
    },
    {
      tabId: 'ai-helper',
      label: 'AI Helper',
      content: (
        <RibbonActions actions={[actions.aiHelper]}>
          <span className="text-sm font-semibold">AI Helper</span>
          <span className="mt-1 text-xs text-muted-foreground">
            Docs와 현재 Workbench 문맥을 참고합니다. AI 응답은 로그인과 GPStation이 필요합니다.
          </span>
        </RibbonActions>
      ),
    },
    {
      tabId: 'recorded-data',
      label: 'RecordedData',
      content: (
        <RibbonActions
          actions={[
            actions.selectMeasurement,
            actions.runSelected,
            ...(workbench.measurementActions.pendingRecordMeasurementId ? [actions.retryRecord] : []),
            actions.generateCandidate,
            actions.saveCurrentMeasurement,
            actions.analyzeMeasurements,
          ]}
        >
          <span className="text-sm font-semibold">
            {workbench.selection.measurement
              ? `Measurement #${workbench.selection.measurement.id}`
              : 'Candidate preview'}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            {workbench.selection.measurement?.recorded_at
              ? 'Recorded · 실행 완료'
              : workbench.selection.measurement
                ? 'Prepared · 실행 가능'
                : '저장되지 않은 현재 조건'}
          </span>
        </RibbonActions>
      ),
    },
  ]

  return { menus, ribbonPanels, toolbar }
}
