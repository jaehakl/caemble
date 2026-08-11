import { useMemo, type Dispatch, type SetStateAction } from 'react'
import {
  Beaker,
  Box,
  ChartNoAxesCombined,
  Database,
  FilePlus2,
  FlaskConical,
  FolderOpen,
  GitBranch,
  Layers3,
  Play,
  RotateCw,
  Save,
  SaveAll,
  TableProperties,
} from 'lucide-react'
import type { WorkbenchAction, WorkbenchMenuDefinition } from '@/features/cae-workbench/chrome'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import type { WorkbenchDialog } from './caePageTypes'
import { RibbonActions } from './RibbonActions'

export function useCaePageChrome({
  authenticated,
  openTab,
  requestPerformMeasurement,
  runSafely,
  setDialog,
  workbench,
}: {
  authenticated: boolean
  openTab: (tab: WorkbenchTabId) => void
  requestPerformMeasurement: () => Promise<void>
  runSafely: (run: () => unknown | Promise<unknown>) => void
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const actions = useMemo<Record<string, WorkbenchAction>>(() => {
    const loginReason = '로그인 후 사용할 수 있습니다.'
    const pairReason = '저장되고 편집되지 않은 Structure + Experiment가 필요합니다.'
    const structureReason = '저장되고 편집되지 않은 Structure가 필요합니다.'
    const experimentReason = '저장되고 편집되지 않은 Experiment가 필요합니다.'
    const busyReason = workbench.measurementActions.busy ? '다른 CAE 작업이 진행 중입니다.' : undefined
    const sourceLockReason = busyReason ?? (workbench.saving ? 'Definition 저장이 진행 중입니다.' : undefined)
    const structureBusyReason = workbench.structureDocument.runIsBusy ? 'Structure 평가가 진행 중입니다.' : busyReason
    const experimentBusyReason = workbench.experimentDocument.runIsBusy
      ? 'Experiment 평가가 진행 중입니다.'
      : busyReason
    const pairBusyReason = workbench.structureDocument.runIsBusy
      ? 'Structure 평가가 진행 중입니다.'
      : workbench.experimentDocument.runIsBusy
        ? 'Experiment 평가가 진행 중입니다.'
        : busyReason
    const defined: Record<string, WorkbenchAction> = {
      newResearch: {
        id: 'new-research',
        label: 'New Research',
        icon: <FilePlus2 className="size-4" />,
        onSelect: () => setDialog('new-research'),
      },
      loadResearch: {
        id: 'load-research',
        label: 'Load Research',
        icon: <FolderOpen className="size-4" />,
        disabled: !authenticated,
        disabledReason: !authenticated ? loginReason : undefined,
        onSelect: () => setDialog('load-research'),
      },
      newStructure: {
        id: 'new-structure',
        label: 'New Structure',
        icon: <Box className="size-4" />,
        onSelect: () => setDialog('new-structure'),
      },
      loadStructure: {
        id: 'load-structure',
        label: 'Load Structure',
        icon: <FolderOpen className="size-4" />,
        onSelect: () => setDialog('load-structure'),
      },
      otherStructures: {
        id: 'other-structures',
        label: 'Other Structures',
        icon: <Layers3 className="size-4" />,
        disabled: !authenticated || !workbench.experimentId,
        disabledReason: !authenticated ? loginReason : !workbench.experimentId ? 'Experiment가 필요합니다.' : undefined,
        onSelect: () => setDialog('other-structures'),
      },
      structureHistory: {
        id: 'structure-history',
        label: 'Structure History',
        icon: <GitBranch className="size-4" />,
        disabled: !authenticated || !workbench.structureId,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.structureId
            ? '저장된 Structure가 필요합니다.'
            : undefined,
        onSelect: () => setDialog('structure-history'),
      },
      saveStructure: {
        id: 'save-structure',
        label: 'Save Structure',
        icon: <Save className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.structure ||
          Boolean(workbench.structureRecord && !workbench.structureManageable) ||
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.structure
            ? 'Structure source가 없습니다.'
            : workbench.structureRecord && !workbench.structureManageable
              ? '다른 사용자의 정의는 Save As로 저장하세요.'
              : workbench.saving
                ? '저장 중입니다.'
                : undefined,
        onSelect: () => setDialog('save-structure'),
      },
      saveStructureAs: {
        id: 'save-structure-as',
        label: 'Save Structure As',
        icon: <SaveAll className="size-4" />,
        disabled: !authenticated || !workbench.structure || workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.structure
            ? 'Structure source가 없습니다.'
            : undefined,
        onSelect: () => setDialog('save-structure-as'),
      },
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
        onSelect: () => setDialog('load-experiment'),
      },
      otherExperiments: {
        id: 'other-experiments',
        label: 'Other Experiments',
        icon: <Layers3 className="size-4" />,
        disabled: !authenticated || !workbench.structureId,
        disabledReason: !authenticated ? loginReason : !workbench.structureId ? 'Structure가 필요합니다.' : undefined,
        onSelect: () => setDialog('other-experiments'),
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
          workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : workbench.experimentRecord && !workbench.experimentManageable
              ? '다른 사용자의 정의는 Save As로 저장하세요.'
              : workbench.saving
                ? '저장 중입니다.'
                : undefined,
        onSelect: () => setDialog('save-experiment'),
      },
      saveExperimentAs: {
        id: 'save-experiment-as',
        label: 'Save Experiment As',
        icon: <SaveAll className="size-4" />,
        disabled: !authenticated || !workbench.experiment || workbench.saving !== null,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experiment
            ? 'Experiment source가 없습니다.'
            : undefined,
        onSelect: () => setDialog('save-experiment-as'),
      },
      materialManager: {
        id: 'material-manager',
        label: 'Material Manager',
        icon: <Database className="size-4" />,
        onSelect: () => setDialog('material'),
      },
      generateSample: {
        id: 'generate-sample',
        label: 'Generate Sample',
        icon: <Box className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.structureClean ||
          workbench.structureDocument.runIsBusy ||
          workbench.measurementActions.busy,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.structureClean
            ? structureReason
            : structureBusyReason,
        onSelect: workbench.measurementActions.generateSample,
      },
      selectSample: {
        id: 'select-sample',
        label: 'Select Sample',
        icon: <TableProperties className="size-4" />,
        disabled: !authenticated || !workbench.structureClean || workbench.measurementActions.busy,
        disabledReason: !authenticated ? loginReason : !workbench.structureClean ? structureReason : busyReason,
        onSelect: () => setDialog('sample'),
      },
      generateSetup: {
        id: 'generate-setup',
        label: 'Generate Setup',
        icon: <FlaskConical className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.experimentClean ||
          workbench.experimentDocument.runIsBusy ||
          workbench.measurementActions.busy,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.experimentClean
            ? experimentReason
            : experimentBusyReason,
        onSelect: workbench.measurementActions.generateSetup,
      },
      selectSetup: {
        id: 'select-setup',
        label: 'Select Setup',
        icon: <TableProperties className="size-4" />,
        disabled: !authenticated || !workbench.experimentClean || workbench.measurementActions.busy,
        disabledReason: !authenticated ? loginReason : !workbench.experimentClean ? experimentReason : busyReason,
        onSelect: () => setDialog('setup'),
      },
      performMeasurement: {
        id: 'perform-measurement',
        label: 'Perform Measurement',
        icon: <Play className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.pairClean ||
          !workbench.selection.sample ||
          !workbench.selection.setup ||
          workbench.measurementActions.busy,
        disabledReason: !authenticated
          ? loginReason
          : !workbench.pairClean
            ? pairReason
            : !workbench.selection.sample || !workbench.selection.setup
              ? 'Sample과 Setup을 선택하세요.'
              : busyReason,
        onSelect: () => runSafely(requestPerformMeasurement),
      },
      generateMeasurement: {
        id: 'generate-measurement',
        label: 'Generate Measurement',
        icon: <Beaker className="size-4" />,
        disabled:
          !authenticated ||
          !workbench.pairClean ||
          workbench.structureDocument.runIsBusy ||
          workbench.experimentDocument.runIsBusy ||
          workbench.measurementActions.busy,
        disabledReason: !authenticated ? loginReason : !workbench.pairClean ? pairReason : pairBusyReason,
        onSelect: workbench.measurementActions.generateMeasurement,
      },
      selectMeasurement: {
        id: 'select-measurement',
        label: 'Select Measurement',
        icon: <TableProperties className="size-4" />,
        disabled: !authenticated || !workbench.pairClean || workbench.measurementActions.busy,
        disabledReason: !authenticated ? loginReason : !workbench.pairClean ? pairReason : busyReason,
        onSelect: () => setDialog('measurement'),
      },
      analyzeMeasurements: {
        id: 'analyze-measurements',
        label: 'Analyze Measurements',
        icon: <ChartNoAxesCombined className="size-4" />,
        disabled: !authenticated || !workbench.pairClean,
        disabledReason: !authenticated ? loginReason : !workbench.pairClean ? pairReason : undefined,
        onSelect: () => setDialog('analysis'),
      },
      structureTab: {
        id: 'tab-structure',
        label: 'Structure Editor',
        icon: <Box className="size-4" />,
        onSelect: () => openTab('structure'),
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
      rerollStructure: {
        id: 'reroll-structure',
        label: 'Reroll',
        icon: <RotateCw className="size-4" />,
        disabled: !workbench.structure || workbench.structureDocument.runIsBusy,
        onSelect: workbench.structureDocument.handleReroll,
      },
      rerollExperiment: {
        id: 'reroll-experiment',
        label: 'Reroll',
        icon: <RotateCw className="size-4" />,
        disabled: !workbench.experiment || workbench.experimentDocument.runIsBusy,
        onSelect: workbench.experimentDocument.handleReroll,
      },
    }
    if (!sourceLockReason) return defined
    const locked = [
      'newResearch',
      'loadResearch',
      'newStructure',
      'loadStructure',
      'otherStructures',
      'structureHistory',
      'saveStructure',
      'saveStructureAs',
      'newExperiment',
      'loadExperiment',
      'otherExperiments',
      'experimentHistory',
      'saveExperiment',
      'saveExperimentAs',
      'rerollStructure',
      'rerollExperiment',
    ]
    return Object.fromEntries(
      Object.entries(defined).map(([key, action]) => [
        key,
        locked.includes(key) ? { ...action, disabled: true, disabledReason: sourceLockReason } : action,
      ]),
    )
  }, [authenticated, openTab, requestPerformMeasurement, runSafely, setDialog, workbench])

  const menus = useMemo<readonly WorkbenchMenuDefinition[]>(
    () => [
      {
        id: 'source',
        label: 'Source',
        items: [
          {
            type: 'submenu',
            id: 'research',
            label: 'Research',
            items: [
              { type: 'action', action: actions.newResearch },
              { type: 'action', action: actions.loadResearch },
            ],
          },
          {
            type: 'submenu',
            id: 'structure',
            label: 'Structure',
            items: [
              { type: 'action', action: actions.newStructure },
              { type: 'action', action: actions.loadStructure },
              { type: 'action', action: actions.otherStructures },
              { type: 'separator', id: 'structure-history-separator' },
              { type: 'action', action: actions.structureHistory },
              { type: 'action', action: actions.saveStructure },
              { type: 'action', action: actions.saveStructureAs },
            ],
          },
          {
            type: 'submenu',
            id: 'experiment',
            label: 'Experiment',
            items: [
              { type: 'action', action: actions.newExperiment },
              { type: 'action', action: actions.loadExperiment },
              { type: 'action', action: actions.otherExperiments },
              { type: 'separator', id: 'experiment-history-separator' },
              { type: 'action', action: actions.experimentHistory },
              { type: 'action', action: actions.saveExperiment },
              { type: 'action', action: actions.saveExperimentAs },
            ],
          },
          { type: 'separator', id: 'material-separator' },
          { type: 'action', action: actions.materialManager },
        ],
      },
      {
        id: 'data',
        label: 'Data',
        items: [
          {
            type: 'submenu',
            id: 'sample',
            label: 'Sample',
            items: [
              { type: 'action', action: actions.generateSample },
              { type: 'action', action: actions.selectSample },
            ],
          },
          {
            type: 'submenu',
            id: 'setup',
            label: 'Setup',
            items: [
              { type: 'action', action: actions.generateSetup },
              { type: 'action', action: actions.selectSetup },
            ],
          },
          {
            type: 'submenu',
            id: 'measurement',
            label: 'Measurement',
            items: [
              { type: 'action', action: actions.performMeasurement },
              { type: 'action', action: actions.generateMeasurement },
              { type: 'action', action: actions.selectMeasurement },
              { type: 'separator', id: 'analysis-separator' },
              { type: 'action', action: actions.analyzeMeasurements },
            ],
          },
        ],
      },
      {
        id: 'view',
        label: 'View',
        items: [
          { type: 'action', action: actions.structureTab },
          { type: 'action', action: actions.experimentTab },
          { type: 'action', action: actions.recordedDataTab },
        ],
      },
    ],
    [actions],
  )

  const toolbar = [
    actions.newResearch,
    actions.loadResearch,
    actions.saveStructure,
    actions.saveExperiment,
    actions.generateSample,
    actions.generateSetup,
    actions.performMeasurement,
    actions.generateMeasurement,
  ]

  const ribbonPanels = [
    {
      tabId: 'structure',
      label: 'Structure',
      content: (
        <RibbonActions
          actions={[
            actions.newStructure,
            actions.loadStructure,
            actions.structureHistory,
            actions.saveStructure,
            actions.saveStructureAs,
            actions.rerollStructure,
          ]}
        >
          <span className="truncate text-sm font-semibold">{workbench.structureName}</span>
          <span className="mt-1 text-xs text-muted-foreground">
            {workbench.structureId ? `#${workbench.structureId}` : 'DB에 저장되지 않음'} · {workbench.structureStatus}
          </span>
        </RibbonActions>
      ),
    },
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
            actions.rerollExperiment,
          ]}
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
      tabId: 'recorded-data',
      label: 'RecordedData',
      content: (
        <RibbonActions
          actions={[
            actions.selectSample,
            actions.selectSetup,
            actions.selectMeasurement,
            actions.performMeasurement,
            actions.generateMeasurement,
            actions.analyzeMeasurements,
          ]}
        >
          <span className="text-sm font-semibold">
            {workbench.selection.measurement
              ? `Measurement #${workbench.selection.measurement.id}`
              : 'Measurement 없음'}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            Sample {workbench.selection.sample ? `#${workbench.selection.sample.id}` : '—'} · Setup{' '}
            {workbench.selection.setup ? `#${workbench.selection.setup.id}` : '—'}
          </span>
        </RibbonActions>
      ),
    },
  ]

  return { menus, ribbonPanels, toolbar }
}
