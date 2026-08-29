import { useQueryClient } from '@tanstack/react-query'
import { Bot, Database, Rows3 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import type { AiAgentApplyRequest, AiAgentApplyResult } from '@/api/aiAgent'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchBottomDock, WorkbenchMenubar, WorkbenchRibbon, WorkbenchShell } from '@/features/cae-workbench/chrome'
import { ConfirmWorkbenchDialog } from '@/features/cae-workbench/dialogs'
import { ExperimentEditor, SourcePathPickerDialog } from '@/features/cae-workbench/editors'
import { ExperimentManager } from '@/features/cae-workbench/experiments'
import {
  CalculationWorkbench,
  type CalculationAgentBridge,
  type CalculationSaveState,
} from '@/features/cae-workbench/calculation'
import { flattenRecordedData, recordedDataRules } from '@/features/cae-workbench/measurement/recordedData'
import type {
  PredictionWorkspaceChromeState,
  PredictionWorkspaceCommand,
} from '@/features/cae-workbench/prediction/PredictionWorkspace'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, HelpKindId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { createRuntimeConsoleStore, RuntimeConsoleView } from '@/features/runtime-console'
import type { CadEditorAuthoringState, CadEditorRevealRequest } from '@/features/viewer/editor/CadEditor'
import {
  findCadSourcePathLocationsByValue,
  type CadSourcePathLocation,
} from '@/features/viewer/editor/cadSelectionSource'
import type { CadViewerSelectionQuery, CadViewerSourceLookupStatus } from '@/features/viewer/viewer/selection'
import { parseRayPathBundles } from '@/lib/cad'
import type { AiChatCommand } from '@/pages/ai/AiChatPage'
import type { AnalysisCommand } from '@/pages/analysis/AnalysisPage'
import { JobsWorkspace } from '@/pages/jobs/JobsPage'
import { LaunchersWorkspace } from '@/pages/launchers/LaunchersPage'
import { MaterialDetail } from '@/pages/materials/MaterialDetailPage'
import { MaterialList } from '@/pages/materials/MaterialListPage'
import { NotFoundPage } from '@/pages/not-found/NotFoundPage'
import { CaeWorkbenchDialogs } from './CaeWorkbenchDialogs'
import { ExperimentDetail } from './WorkbenchDetails'
import { WorkbenchHelpDetail, WorkbenchHelpExplorer } from './WorkbenchHelp'
import {
  useCaePageChrome,
  type AnalysisRibbonCommand,
  type LabRibbonCommand,
  type MaterialRibbonCommand,
  type PredictionRibbonCommand,
} from './useCaePageChrome'
import { useCaePageSession } from './useCaePageSession'

const AiHelperWorkspace = lazy(() =>
  import('@/pages/ai/AiHelperPage').then((module) => ({ default: module.AiHelperWorkspace })),
)
const AiChatWorkspace = lazy(() =>
  import('@/pages/ai/AiChatPage').then((module) => ({ default: module.AiChatWorkspace })),
)
const AnalysisWorkspace = lazy(() =>
  import('@/pages/analysis/AnalysisPage').then((module) => ({ default: module.AnalysisWorkspace })),
)
const PredictionWorkspace = lazy(() =>
  import('@/features/cae-workbench/prediction/PredictionWorkspace').then((module) => ({
    default: module.PredictionWorkspace,
  })),
)

export function CaePage() {
  const location = useLocation()
  if (location.hash) return <NotFoundPage />
  return <AuthenticatedCaePage />
}

function AuthenticatedCaePage() {
  const auth = useAuth()
  return <CaeWorkbenchPage auth={auth} />
}

function CaeWorkbenchPage({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const queryClient = useQueryClient()
  const runtimeConsole = useMemo(() => createRuntimeConsoleStore(), [])
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated, { onActivity: runtimeConsole.append })
  const [calculationDirty, setCalculationDirty] = useState(false)
  const [calculationSaveCommand, setCalculationSaveCommand] = useState(0)
  const [calculationSaveState, setCalculationSaveState] = useState<CalculationSaveState>({
    disabled: true,
    disabledReason: 'Calculation Editor를 불러오는 중입니다.',
  })
  const [calculationAgentBridge, setCalculationAgentBridge] = useState<CalculationAgentBridge | null>(null)
  const page = useCaePageSession(workbench, { hasUnsavedCalculationWork: calculationDirty })
  const [experimentAuthoringState, setExperimentAuthoringState] = useState<CadEditorAuthoringState | null>(null)
  const [viewerSelectionQuery, setViewerSelectionQuery] = useState<CadViewerSelectionQuery | null>(null)
  const [sourceRevealRequest, setSourceRevealRequest] = useState<
    (CadEditorRevealRequest & Readonly<{ path: string }>) | null
  >(null)
  const [sourcePathPicker, setSourcePathPicker] = useState<Readonly<{
    locations: readonly CadSourcePathLocation[]
    value: string
  }> | null>(null)
  const [selectionSourcePaths, setSelectionSourcePaths] = useState<readonly string[]>([])
  const [selectionSourceLookup, setSelectionSourceLookup] = useState<
    Readonly<{
      files: Readonly<Record<string, string>> | null
      locations: ReadonlyMap<string, readonly CadSourcePathLocation[]>
      pathKey: string
    }>
  >({ files: null, locations: new Map(), pathKey: '' })
  const [analysisSettingsContainer, setAnalysisSettingsContainer] = useState<HTMLDivElement | null>(null)
  const [predictionVarsContainer, setPredictionVarsContainer] = useState<HTMLDivElement | null>(null)
  const [chatSettingsContainer, setChatSettingsContainer] = useState<HTMLDivElement | null>(null)
  const [analysisCommand, setAnalysisCommand] = useState<AnalysisCommand | null>(null)
  const [predictionCommand, setPredictionCommand] = useState<PredictionWorkspaceCommand | null>(null)
  const [predictionState, setPredictionState] = useState<PredictionWorkspaceChromeState>({
    busy: false,
    canValidate: false,
    direction: 'forward',
    status: 'Prediction을 준비하는 중입니다.',
    validateDisabledReason: 'Prediction 결과가 필요합니다.',
  })
  const [chatCommand, setChatCommand] = useState<AiChatCommand | null>(null)
  const [materialCommand, setMaterialCommand] = useState<Readonly<{ id: number; type: MaterialRibbonCommand }> | null>(
    null,
  )
  const [agentActivated, setAgentActivated] = useState(false)
  const [labActivated, setLabActivated] = useState(false)
  const [predictionActivated, setPredictionActivated] = useState(false)
  const commandSequence = useRef(0)
  const selectedMaterialId = page.materialId
  const selectionSourceFiles =
    workbench.experiment?.kind === 'experiment' ? workbench.experiment.sourceBundle.files : null
  const selectionSourcePathKey = selectionSourcePaths.join('\u0000')

  const selectionSourceStatus = useMemo(() => {
    const ready =
      selectionSourceLookup.files === selectionSourceFiles && selectionSourceLookup.pathKey === selectionSourcePathKey
    const status: Record<string, CadViewerSourceLookupStatus> = {}
    selectionSourcePaths.forEach((value) => {
      status[value] = ready
        ? selectionSourceLookup.locations.get(value)?.length
          ? 'available'
          : 'missing'
        : 'checking'
    })
    return status
  }, [selectionSourceFiles, selectionSourceLookup, selectionSourcePathKey, selectionSourcePaths])

  const revealSourceLocation = useCallback(
    (location: CadSourcePathLocation) => {
      const reveal = () => {
        setSourcePathPicker(null)
        setSourceRevealRequest({
          end: location.end,
          id: ++commandSequence.current,
          path: location.path,
          start: location.start,
        })
        page.setLayout((current) => ({
          ...current,
          activeExperimentFile: location.path,
          activeSection: 'experiment',
          rightTabs: { ...current.rightTabs, experiment: 'source' },
          viewerExpanded: false,
        }))
      }
      if (page.activeSection === 'measurement' && calculationDirty) page.guardReplacement(reveal)
      else reveal()
    },
    [calculationDirty, page],
  )

  const findSelectionSource = useCallback(
    (value: string) => {
      if (
        selectionSourceLookup.files !== selectionSourceFiles ||
        selectionSourceLookup.pathKey !== selectionSourcePathKey
      )
        return
      const locations = selectionSourceLookup.locations.get(value) ?? []
      if (locations.length === 1) {
        revealSourceLocation(locations[0])
      } else if (locations.length > 1) {
        setSourcePathPicker({ locations, value })
      }
    },
    [revealSourceLocation, selectionSourceFiles, selectionSourceLookup, selectionSourcePathKey],
  )

  const handleSelectionSourcePathsChange = useCallback((values: readonly string[]) => {
    setSelectionSourcePaths((current) =>
      current.length === values.length && current.every((value, index) => value === values[index])
        ? current
        : [...values],
    )
  }, [])

  const handleCodeSelectionQueryChange = useCallback((query: CadViewerSelectionQuery | null) => {
    setViewerSelectionQuery((current) => {
      if (query) return query
      return current?.origin === 'code' ? null : current
    })
  }, [])

  useEffect(() => {
    setViewerSelectionQuery(null)
    setSourcePathPicker(null)
    setSourceRevealRequest(null)
    setSelectionSourcePaths([])
    setSelectionSourceLookup({ files: null, locations: new Map(), pathKey: '' })
  }, [workbench.agentWorkspaceSession])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      const locations = selectionSourceFiles
        ? findCadSourcePathLocationsByValue(selectionSourceFiles, selectionSourcePaths)
        : new Map(selectionSourcePaths.map((value) => [value, []] as const))
      if (!cancelled) {
        setSelectionSourceLookup({
          files: selectionSourceFiles,
          locations,
          pathKey: selectionSourcePathKey,
        })
      }
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [selectionSourceFiles, selectionSourcePathKey, selectionSourcePaths])

  useEffect(() => {
    if (page.bottomMode === 'agent') setAgentActivated(true)
  }, [page.bottomMode])

  useEffect(() => {
    if (page.activeSection === 'lab') setLabActivated(true)
    if (page.activeSection === 'prediction') setPredictionActivated(true)
  }, [page.activeSection])

  useEffect(() => {
    if (page.activeSection !== 'analysis') setAnalysisCommand(null)
    if (page.activeSection !== 'prediction') setPredictionCommand(null)
    if (page.activeSection !== 'lab') setChatCommand(null)
    if (page.activeSection !== 'material') setMaterialCommand(null)
  }, [page.activeSection])

  useEffect(() => {
    setMaterialCommand(null)
  }, [selectedMaterialId])

  const setActiveSection = useCallback(
    (activeSection: WorkbenchSectionId) => {
      const changeSection = () => page.setLayout((current) => ({ ...current, activeSection }))
      if (page.activeSection === 'measurement' && activeSection !== 'measurement' && calculationDirty) {
        page.guardReplacement(changeSection)
      } else {
        changeSection()
      }
    },
    [calculationDirty, page],
  )
  const setSelectedMaterialId = useCallback(
    (materialId: number | null) => page.setLayout((current) => ({ ...current, materialId })),
    [page],
  )
  const setAnalysisTab = useCallback(
    (analysisTab: AnalysisTabId) => page.setLayout((current) => ({ ...current, analysisTab })),
    [page],
  )
  const setHelpKind = useCallback(
    (kind: HelpKindId) =>
      page.setLayout((current) => ({
        ...current,
        help: { kind, item: kind === 'manual' ? 'program-overview' : null },
      })),
    [page],
  )
  const requestAnalysisCommand = useCallback((type: AnalysisRibbonCommand) => {
    setAnalysisCommand({ id: ++commandSequence.current, type })
  }, [])
  const requestLabCommand = useCallback((type: LabRibbonCommand) => {
    setChatCommand({ id: ++commandSequence.current, type })
  }, [])
  const requestMaterialCommand = useCallback((type: MaterialRibbonCommand) => {
    setMaterialCommand({ id: ++commandSequence.current, type })
  }, [])
  const requestPredictionCommand = useCallback((type: PredictionRibbonCommand) => {
    setPredictionCommand({ id: ++commandSequence.current, type })
  }, [])
  const requestCalculationSave = useCallback(() => {
    setCalculationSaveCommand((current) => current + 1)
  }, [])
  const refreshRuntime = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['runtime', 'launchers'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime', 'jobs'] }),
    ])
  }, [queryClient])

  const chrome = useCaePageChrome({
    analysisTab: page.analysisTab,
    authenticated: auth.isAuthenticated,
    calculationDirty,
    calculationSaveState,
    experimentAuthoringState,
    guardReplacement: page.guardReplacement,
    helpKind: page.help.kind,
    materialSelected: selectedMaterialId !== null,
    refreshRuntime,
    requestAnalysisCommand,
    requestCalculationSave,
    requestPredictionCommand,
    selectedCalculationId: page.calculationId,
    requestLabCommand,
    requestMaterialCommand,
    requestRunSelected: page.requestRunSelected,
    runSafely: page.runSafely,
    setActiveSection,
    setAnalysisTab,
    setDialog: page.setDialog,
    setHelpKind,
    workbench,
    predictionState,
  })

  const sessionRecordedSchemas = workbench.experimentDocument.simulationProgram?.recordedData ?? Object.freeze({})
  const sessionRecordedRules = useMemo(
    () => recordedDataRules(sessionRecordedSchemas, 'measurement.session-recorded-data'),
    [sessionRecordedSchemas],
  )
  const sessionFlatRecordedData = useMemo(
    () => flattenRecordedData(sessionRecordedSchemas, workbench.simulation.recordedData),
    [sessionRecordedSchemas, workbench.simulation.recordedData],
  )
  const pendingResult = workbench.measurementActions.pendingRecordMeasurementId !== null
  const activeRecordedData = pendingResult ? workbench.simulation.recordedData : workbench.selection.recordedData
  const activeFlatRecordedData = pendingResult ? sessionFlatRecordedData : workbench.selection.flatRecordedData
  const activeRecordedRows = pendingResult ? [] : workbench.selection.recordedRows
  const activeRecordedSchemas = pendingResult ? sessionRecordedSchemas : workbench.selection.recordedSchemas
  const activeRecordedRules = pendingResult ? sessionRecordedRules : workbench.selection.recordedRules
  const rayPathState = useMemo(() => {
    try {
      return { bundles: parseRayPathBundles(activeRecordedSchemas, activeRecordedData), error: null }
    } catch (error) {
      return { bundles: [], error: error instanceof Error ? error.message : String(error) }
    }
  }, [activeRecordedData, activeRecordedSchemas])

  const applyAgentBundleNow = async (request: AiAgentApplyRequest) => {
    if (request.finalDocument.kind !== 'experiment') {
      return { status: 'conflicted' as const, message: 'Experiment Agent 결과가 아닙니다.' }
    }
    const result = await workbench.applyAgentBundle({
      ...request,
      finalDocument: request.finalDocument,
    })
    if (result.firstChangedFile) {
      page.setActiveExperimentFile(result.firstChangedFile)
      page.setLayout((current) => ({
        ...current,
        activeSection: 'experiment',
        rightTabs: { ...current.rightTabs, experiment: 'source' },
      }))
    }
    return result
  }
  const applyAgentBundle = (request: AiAgentApplyRequest) => {
    if (page.activeSection !== 'measurement' || !calculationDirty) return applyAgentBundleNow(request)
    return new Promise<AiAgentApplyResult>((resolve, reject) => {
      page.guardReplacement(
        () => applyAgentBundleNow(request).then(resolve, reject),
        () =>
          resolve({
            message: '저장하지 않은 Calculation 편집을 유지하기 위해 Agent 변경을 적용하지 않았습니다.',
            status: 'conflicted',
          }),
      )
    })
  }

  const applyAgentDocument = (request: AiAgentApplyRequest) => {
    if (request.finalDocument.kind === 'experiment') return applyAgentBundle(request)
    const experimentHash = workbench.agentWorkspaceIdentity?.baseHash ?? null
    if (!calculationAgentBridge || !experimentHash || request.referenceHash !== experimentHash) {
      return Promise.resolve<AiAgentApplyResult>({
        status: 'conflicted',
        message: 'Calculation Agent 실행 중 대상 또는 Experiment reference가 변경되었습니다.',
      })
    }
    return calculationAgentBridge.apply(request)
  }

  const leftPane =
    page.activeSection === 'experiment' ? (
      <ExperimentManager
        authenticated={auth.isAuthenticated}
        busy={workbench.saving !== null || workbench.measurementActions.busy || workbench.calculationDataActions.busy}
        compact
        selectedId={workbench.experimentId}
        user={auth.user}
        onDeleteSelected={() => {
          page.setCalculationId(null)
          workbench.detachDeletedExperiment()
        }}
        onOpenSaved={(row) =>
          page.guardReplacement(async () => {
            await workbench.loadExperiment(row)
            page.setCalculationId(null)
            page.setLayout((current) => ({ ...current, activeSection: 'experiment' }))
          })
        }
        onOpenExample={(sourceBundle, name, description) =>
          page.guardReplacement(() => {
            workbench.newExperiment(sourceBundle, name, description)
            page.setCalculationId(null)
            page.setLayout((current) => ({ ...current, activeSection: 'experiment' }))
          })
        }
      />
    ) : page.activeSection === 'measurement' ? null : page.activeSection === 'prediction' ? (
      <div className="h-full min-h-0 overflow-hidden bg-background p-2" ref={setPredictionVarsContainer} />
    ) : page.activeSection === 'material' ? (
      <MaterialList
        command={
          materialCommand?.type === 'new' || materialCommand?.type === 'refresh'
            ? { id: materialCommand.id, type: materialCommand.type }
            : null
        }
        compact
        selectedMaterialId={selectedMaterialId}
        onSelectMaterial={setSelectedMaterialId}
      />
    ) : page.activeSection === 'analysis' ? (
      <div className="h-full min-h-0 overflow-auto bg-background" ref={setAnalysisSettingsContainer} />
    ) : page.activeSection === 'lab' ? (
      <div className="h-full min-h-0 overflow-auto bg-background" ref={setChatSettingsContainer} />
    ) : page.activeSection === 'help' ? (
      <WorkbenchHelpExplorer
        kind={page.help.kind}
        selectedItem={page.help.item}
        onSelectedItemChange={(item) => page.setLayout((current) => ({ ...current, help: { ...current.help, item } }))}
      />
    ) : (
      <LaunchersWorkspace className="h-full" compact onRequestLogin={() => page.setDialog('account')} />
    )

  const contextualRightPane =
    page.activeSection === 'experiment' ? (
      <PaneTabs
        label="Experiment"
        options={[
          { id: 'source', label: 'Source' },
          { id: 'detail', label: 'Detail' },
        ]}
        value={page.rightTabs.experiment}
        onValueChange={(experiment) =>
          page.setLayout((current) => ({
            ...current,
            rightTabs: { ...current.rightTabs, experiment: experiment as 'source' | 'detail' },
          }))
        }
        panels={{
          source: (
            <ExperimentEditor
              agentChange={workbench.agentChange}
              controller={workbench.experimentDocument}
              disabled={
                !page.initialized ||
                pendingResult ||
                workbench.measurementActions.busy ||
                workbench.calculationDataActions.busy ||
                workbench.saving !== null
              }
              document={workbench.experiment?.kind === 'experiment' ? workbench.experiment : null}
              initialActiveFile={page.activeExperimentFile}
              onActiveFileChange={page.setActiveExperimentFile}
              onAuthoringStateChange={setExperimentAuthoringState}
              onSourceRevealRequestHandled={(id) =>
                setSourceRevealRequest((current) => (current?.id === id ? null : current))
              }
              onUndoAgentChange={workbench.undoAgentChange}
              onViewerSelectionQueryChange={handleCodeSelectionQueryChange}
              sourceRevealRequest={sourceRevealRequest}
            />
          ),
          detail: <ExperimentDetail workbench={workbench} />,
        }}
      />
    ) : page.activeSection === 'measurement' || page.activeSection === 'prediction' ? null : page.activeSection ===
      'material' ? (
      selectedMaterialId ? (
        <MaterialDetail
          command={
            materialCommand && materialCommand.type !== 'new' && materialCommand.type !== 'refresh'
              ? { id: materialCommand.id, type: materialCommand.type }
              : null
          }
          compact
          materialId={selectedMaterialId}
          onDeleted={() => setSelectedMaterialId(null)}
          onRequestLogin={() => page.setDialog('account')}
        />
      ) : (
        <PaneEmpty icon={<Database />} title="Material을 선택하세요" />
      )
    ) : page.activeSection === 'analysis' ? (
      <Suspense fallback={<PaneLoading label="Analysis를 불러오는 중입니다." />}>
        <AnalysisWorkspace
          command={analysisCommand}
          embedded
          experimentId={workbench.experimentId}
          settingsContainer={analysisSettingsContainer}
          tab={page.analysisTab}
          onRequestLogin={() => page.setDialog('account')}
          onTabChange={setAnalysisTab}
        />
      </Suspense>
    ) : page.activeSection === 'lab' ? null : page.activeSection === 'help' ? (
      <WorkbenchHelpDetail kind={page.help.kind} selectedItem={page.help.item} />
    ) : (
      <JobsWorkspace className="h-full" compact onRequestLogin={() => page.setDialog('account')} />
    )

  const rightPane = (
    <div className="h-full min-h-0 overflow-hidden">
      <div
        className={page.activeSection === 'lab' || page.activeSection === 'prediction' ? 'hidden' : 'h-full min-h-0'}
        hidden={page.activeSection === 'lab' || page.activeSection === 'prediction'}
      >
        {contextualRightPane}
      </div>
      {predictionActivated ? (
        <div
          className={page.activeSection === 'prediction' ? 'h-full min-h-0 p-2' : 'hidden'}
          hidden={page.activeSection !== 'prediction'}
        >
          <Suspense fallback={<PaneLoading label="Prediction을 불러오는 중입니다." />}>
            <PredictionWorkspace
              active={page.activeSection === 'prediction'}
              authenticated={auth.isAuthenticated}
              command={predictionCommand}
              onActivity={runtimeConsole.append}
              onChromeStateChange={setPredictionState}
              onRequestLogin={() => page.setDialog('account')}
              selectedCalculationId={page.calculationId}
              varsContainer={predictionVarsContainer}
              workbench={workbench}
            />
          </Suspense>
        </div>
      ) : null}
      {labActivated ? (
        <div
          className={page.activeSection === 'lab' ? 'h-full min-h-0' : 'hidden'}
          hidden={page.activeSection !== 'lab'}
        >
          <Suspense fallback={<PaneLoading label="AI Chat을 불러오는 중입니다." />}>
            <AiChatWorkspace
              command={chatCommand}
              settingsContainer={chatSettingsContainer}
              onRequestLogin={() => page.setDialog('account')}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  )

  const viewerPane = (
    <WorkbenchViewer
      activeExperimentTaskName={page.activeExperimentFile}
      experiment={workbench.experiment}
      experimentDocument={workbench.experimentDocument}
      onFindSelectionSource={findSelectionSource}
      onSelectionQueryChange={setViewerSelectionQuery}
      onSelectionSourcePathsChange={handleSelectionSourcePathsChange}
      onToggleViewerExpanded={() =>
        page.setLayout((current) => ({ ...current, viewerExpanded: !current.viewerExpanded }))
      }
      rayPaths={rayPathState.bundles}
      selectionQuery={viewerSelectionQuery}
      selectionSourceStatus={selectionSourceStatus}
      viewerExpanded={page.viewerExpanded}
    />
  )
  const menubar = <WorkbenchMenubar activeSectionId={page.activeSection} onActiveSectionChange={setActiveSection} />
  const ribbon = <WorkbenchRibbon activeSectionId={page.activeSection} panels={chrome.ribbonPanels} />
  const experimentHash = workbench.agentWorkspaceIdentity?.baseHash ?? null
  const agentTarget =
    page.activeSection === 'measurement'
      ? calculationAgentBridge && workbench.experiment
        ? {
            document: {
              kind: 'calculation' as const,
              calculationId: calculationAgentBridge.calculationId,
              experimentId: calculationAgentBridge.experimentId,
              name: calculationAgentBridge.name,
              description: calculationAgentBridge.description,
              sourceCode: calculationAgentBridge.sourceCode,
              editable: calculationAgentBridge.editable,
              context: calculationAgentBridge.context,
              referenceExperiment: workbench.experiment,
            },
            baseHash: calculationAgentBridge.baseHash,
            referenceHash: experimentHash,
            experimentId: calculationAgentBridge.experimentId,
            key: `calculation:${calculationAgentBridge.experimentId}:${calculationAgentBridge.calculationId ?? `new:${calculationAgentBridge.workspaceSession}`}`,
            workspaceSession: calculationAgentBridge.workspaceSession,
            label: `${calculationAgentBridge.targetLabel}${calculationAgentBridge.name ? ` · ${calculationAgentBridge.name}` : ''}`,
          }
        : null
      : workbench.experiment
        ? {
            document: workbench.experiment,
            baseHash: experimentHash,
            referenceHash: null,
            experimentId: workbench.experimentId,
            key: `experiment:${workbench.experimentId ?? `new:${workbench.agentWorkspaceSession}`}`,
            workspaceSession: workbench.agentWorkspaceSession,
            label: `Experiment · ${workbench.experimentName || (workbench.experimentId ? `#${workbench.experimentId}` : 'New')}`,
          }
        : null
  const bottomDock = (
    <WorkbenchBottomDock
      mode={page.bottomMode}
      onModeChange={(bottomMode) => page.setLayout((current) => ({ ...current, bottomMode }))}
      agent={
        agentActivated ? (
          <Suspense fallback={<PaneLoading label="AI Agent를 불러오는 중입니다." />}>
            <AiHelperWorkspace
              activeExperimentFile={page.activeExperimentFile}
              activeTab="ai-helper"
              target={agentTarget}
              onApplyStagedDocument={applyAgentDocument}
              onRequestLogin={() => page.setDialog('account')}
            />
          </Suspense>
        ) : (
          <PaneEmpty icon={<Bot />} title="AI Agent" />
        )
      }
      console={<RuntimeConsoleView store={runtimeConsole} />}
    />
  )

  return (
    <main className="flex h-dvh min-h-[560px] min-w-[1280px] flex-col overflow-hidden bg-background text-foreground">
      <div aria-busy={!page.initialized} className="relative min-h-0 flex-1" inert={!page.initialized}>
        {page.activeSection === 'measurement' ? (
          <CalculationWorkbench
            authenticated={auth.isAuthenticated}
            agentWorkspaceSession={workbench.agentWorkspaceSession}
            bottom={bottomDock}
            bottomHeightRatio={page.bottomHeightRatio}
            bottomMode={page.bottomMode}
            busy={
              workbench.measurementActions.busy ||
              workbench.calculationDataActions.busy ||
              Boolean(workbench.measurementActions.pendingRecordMeasurementId)
            }
            calculationDataBusy={workbench.calculationDataActions.busy}
            candidateEditingDisabled={
              workbench.measurementActions.busy ||
              workbench.calculationDataActions.busy ||
              Boolean(workbench.measurementActions.pendingRecordMeasurementId)
            }
            candidateSessionKey={`${workbench.experimentId ?? 'none'}`}
            candidateVars={workbench.candidateVars}
            columnRatios={page.calculationColumnRatios ?? [0.22, 0.26, 0.26, 0.26]}
            contextPending={page.calculationContextPending}
            editable={workbench.experimentManageable}
            experimentId={workbench.experimentId}
            measurementId={workbench.selection.measurement?.id ?? null}
            measurementLoading={workbench.selection.loading}
            menubar={menubar}
            onActivity={runtimeConsole.append}
            onAgentBridgeChange={setCalculationAgentBridge}
            onBottomHeightRatioChange={(bottomHeightRatio) =>
              page.setLayout((current) => ({ ...current, bottomHeightRatio }))
            }
            onCandidateVariableChange={workbench.setCandidateVariable}
            onCalculationIdChange={page.setCalculationId}
            onColumnRatiosChange={(calculationColumnRatios) =>
              page.setLayout((current) => ({ ...current, calculationColumnRatios }))
            }
            onDeleteMeasurements={workbench.measurementActions.deleteMeasurements}
            onDirtyChange={setCalculationDirty}
            onOutputChartRatioChange={(calculationOutputChartRatio) =>
              page.setLayout((current) => ({ ...current, calculationOutputChartRatio }))
            }
            onRowRatiosChange={(calculationLeftRowRatios) =>
              page.setLayout((current) => ({ ...current, calculationLeftRowRatios }))
            }
            onSaveStateChange={setCalculationSaveState}
            onSelectMeasurement={(row) => page.runSafely(() => workbench.selection.loadMeasurement(row))}
            onClearMeasurement={workbench.selection.clearMeasurement}
            onUsageChanged={workbench.refreshExperimentUsage}
            recordedData={activeFlatRecordedData}
            recordedRows={activeRecordedRows}
            recordedRules={activeRecordedRules}
            ribbon={ribbon}
            rowRatios={page.calculationLeftRowRatios ?? [0.45, 0.25, 0.3]}
            saveCommand={calculationSaveCommand}
            outputChartRatio={page.calculationOutputChartRatio ?? 0.65}
            selectedCalculationId={page.calculationId}
            varsSchema={workbench.experimentDocument.varsSchema}
            viewer={viewerPane}
            viewerExpanded={page.viewerExpanded}
          />
        ) : (
          <WorkbenchShell
            bottom={bottomDock}
            bottomHeightRatio={page.bottomHeightRatio}
            bottomMode={page.bottomMode}
            viewerExpanded={page.viewerExpanded}
            className="h-full min-h-0"
            left={leftPane}
            leftLabel={`${page.activeSection} 목록 및 설정`}
            leftWidthRatio={page.leftWidthRatio}
            menubar={menubar}
            ribbon={ribbon}
            right={rightPane}
            rightLabel={`${page.activeSection} Detail`}
            rightWidthRatio={page.rightWidthRatio}
            viewer={viewerPane}
            onBottomHeightRatioChange={(bottomHeightRatio) =>
              page.setLayout((current) => ({ ...current, bottomHeightRatio }))
            }
            onLeftWidthRatioChange={(leftWidthRatio) => page.setLayout((current) => ({ ...current, leftWidthRatio }))}
            onRightWidthRatioChange={(rightWidthRatio) =>
              page.setLayout((current) => ({ ...current, rightWidthRatio }))
            }
          />
        )}
        {!page.initialized ? (
          <div
            aria-label="CAE 작업 복원 중"
            className="absolute inset-0 z-50 flex items-center justify-center bg-background/55 text-sm font-medium backdrop-blur-[1px]"
            role="status"
          >
            작업을 복원하는 중입니다.
          </div>
        ) : null}
      </div>
      <footer className="flex h-7 shrink-0 items-center justify-between gap-3 border-t bg-muted/35 px-3 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2 truncate">
          <Badge className="h-5 max-w-[38vw] truncate rounded-sm px-1.5 font-mono">
            {workbench.experimentCoordinate ?? 'local Experiment'}
          </Badge>
          {workbench.experimentVersion ? (
            <Badge className="h-5 rounded-sm px-1.5">v{workbench.experimentVersion}</Badge>
          ) : null}
          {workbench.experimentDirty ? (
            <Badge className="h-5 rounded-sm bg-destructive px-1.5 text-white">Dirty</Badge>
          ) : null}
          {workbench.sourceLocked ? (
            <Badge className="h-5 rounded-sm bg-amber-600 px-1.5 text-white">Locked</Badge>
          ) : null}
          {!workbench.hasTasks ? (
            <Badge className="h-5 rounded-sm bg-muted px-1.5">Preview only · Task 없음</Badge>
          ) : null}
          <Badge className="h-5 rounded-sm px-1.5">
            {workbench.measurementActions.pendingRecordMeasurementId
              ? `Measurement #${workbench.measurementActions.pendingRecordMeasurementId} · 결과 저장 재시도 필요`
              : workbench.selection.measurement
                ? `Measurement #${workbench.selection.measurement.id} · ${workbench.selection.measurement.recorded_at ? 'Recorded' : 'Prepared'}`
                : 'Candidate preview'}
          </Badge>
        </span>
        {workbench.measurementActions.busy ? (
          <span className="flex items-center gap-2">
            {workbench.measurementActions.stage}
            {workbench.measurementActions.cancelable ? (
              <button
                className="font-medium text-destructive"
                type="button"
                onClick={workbench.measurementActions.cancel}
              >
                취소
              </button>
            ) : null}
          </span>
        ) : workbench.calculationDataActions.busy ? (
          <span className="flex items-center gap-2">
            {workbench.calculationDataActions.progress?.stage}
            <button
              className="font-medium text-destructive"
              type="button"
              onClick={workbench.calculationDataActions.cancel}
            >
              취소
            </button>
          </span>
        ) : (
          <span>
            {auth.isAuthenticated
              ? auth.user?.display_name || auth.user?.email || 'Signed in'
              : 'Local editing · 서버 기능은 로그인 필요'}
          </span>
        )}
      </footer>

      <CaeWorkbenchDialogs dialog={page.dialog} setDialog={page.setDialog} workbench={workbench} />
      <SourcePathPickerDialog
        locations={sourcePathPicker?.locations ?? []}
        open={sourcePathPicker !== null}
        value={sourcePathPicker?.value ?? ''}
        onOpenChange={(open) => !open && setSourcePathPicker(null)}
        onSelect={revealSourceLocation}
      />
      <ConfirmWorkbenchDialog
        confirmLabel={page.confirmation?.confirmLabel}
        description={page.confirmation?.description ?? ''}
        open={page.confirmation !== null}
        title={page.confirmation?.title ?? ''}
        onCancel={() => {
          const pending = page.confirmation
          page.setConfirmation(null)
          pending?.cancel?.()
        }}
        onConfirm={() => {
          const pending = page.confirmation
          page.setConfirmation(null)
          if (pending) page.runSafely(pending.run)
        }}
      />
    </main>
  )
}

function PaneTabs({
  label,
  onValueChange,
  options,
  panels,
  value,
}: {
  label: string
  onValueChange: (value: string) => void
  options: readonly Readonly<{ id: string; label: string }>[]
  panels: Readonly<Record<string, ReactNode>>
  value: string
}) {
  return (
    <Tabs className="flex h-full min-h-0 flex-col" value={value} onValueChange={onValueChange}>
      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <TabsList aria-label={`${label} Detail 보기`} className="h-7">
          {options.map((option) => (
            <TabsTrigger className="h-6 px-2 text-xs" key={option.id} value={option.id}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {options.map((option) => (
        <TabsContent
          className="mt-0 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
          forceMount
          key={option.id}
          value={option.id}
        >
          {panels[option.id]}
        </TabsContent>
      ))}
    </Tabs>
  )
}

function PaneEmpty({ description, icon, title }: { description?: string; icon: ReactNode; title: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-xs text-muted-foreground [&_svg]:mx-auto [&_svg]:size-8">
        {icon}
        <p className="mt-3 font-medium text-foreground">{title}</p>
        {description ? <p className="mt-1 text-sm">{description}</p> : null}
      </div>
    </div>
  )
}

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <Rows3 className="mr-2 inline size-4 animate-pulse" />
      {label}
    </div>
  )
}

export const Component = CaePage
