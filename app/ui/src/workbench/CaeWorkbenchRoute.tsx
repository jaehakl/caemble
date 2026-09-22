import { varsFingerprint } from '@/lib/cad/model/vars'
import { MeasurementWorkspace } from '@/features/measurement/MeasurementWorkspace'
import { useExperimentWarnings } from '@/features/cae-workbench/useExperimentWarnings'
import { usePreflight } from '@/features/measurement/usePreflight'
import { Rows3 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '@/features/auth/use-auth'
import { NotFoundView } from '@/features/error/NotFoundView'
import {
  defaultWorkbenchSections,
  WorkbenchBottomDock,
  WorkbenchConsoleLayout,
  WorkbenchMenubar,
  WorkbenchRibbon,
} from '@/features/cae-workbench/chrome'
import { ConfirmWorkbenchDialog } from '@/features/cae-workbench/dialogs'
import { ExperimentEditor, SourcePathPickerDialog } from '@/features/cae-workbench/editors'
import { useExperimentSaveWorkflow } from '@/features/experiment/useExperimentSaveWorkflow'
import { ExperimentWorkspace } from '@/features/cae-workbench/chrome/ExperimentWorkspace'
import { calculationAccessPolicy, type CalculationSaveState } from '@/features/calculation'
import type {
  PredictionViewerState,
  PredictionWorkspaceChromeState,
  PredictionWorkspaceCommand,
} from '@/features/prediction/PredictionWorkspace'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { createRuntimeConsoleStore, RuntimeConsoleSummary, RuntimeConsoleView } from '@/features/runtime-console'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { useSelectionSourceNavigation } from '@/features/cae-workbench/viewer/useSelectionSourceNavigation'
import { useWorkbenchShell, WorkbenchShellProvider } from '@/workbench/state/workbenchShellStore'
import { CalculationWorkbenchContainer } from '@/workbench/CalculationWorkbenchContainer'
import { WorkbenchShellContainer } from '@/workbench/WorkbenchShellContainer'
import type { AnalysisCommand } from '@/features/analysis/AnalysisPage'
import { useCaeBatches } from '@/features/cae/CaeBatchProvider'
import { useCaeBatchConsole } from '@/features/cae/useCaeBatchConsole'
import { CaeWorkbenchDialogs } from '@/features/cae-workbench/CaeWorkbenchDialogs'
import {
  useCaePageChrome,
  type AnalysisRibbonCommand,
  type PredictionRibbonCommand,
} from '@/features/cae-workbench/useCaePageChrome'
import { useCaePageSession } from '@/workbench/useCaePageSession'

const AnalysisWorkspace = lazy(() =>
  import('@/features/analysis/AnalysisPage').then((module) => ({ default: module.AnalysisWorkspace })),
)
const PredictionWorkspace = lazy(() =>
  import('@/features/prediction/PredictionWorkspace').then((module) => ({
    default: module.PredictionWorkspace,
  })),
)

export function CaeWorkbenchRoute() {
  const location = useLocation()
  if (location.hash) return <NotFoundView />
  return <AuthenticatedCaePage />
}

function AuthenticatedCaePage() {
  const auth = useAuth()
  return (
    <WorkbenchShellProvider key={auth.queryScope}>
      <CaeWorkbenchPage auth={auth} />
    </WorkbenchShellProvider>
  )
}

function CaeWorkbenchPage({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const location = useLocation()
  const navigate = useNavigate()
  const runtimeConsole = useMemo(() => createRuntimeConsoleStore(), [])
  const predictionMode = useWorkbenchShell((state) => state.layout.activeSection === 'prediction')
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated, {
    onActivity: runtimeConsole.append,
    predictionMode,
  })
  const preflight = usePreflight(
    workbench.experiment,
    workbench.experimentDocument,
    `${workbench.experimentId ?? ''}:${workbench.experimentDocument.resultSessionKey ?? ''}:${workbench.selection.measurement?.id ?? ''}`,
    runtimeConsole.append,
  )
  useExperimentWarnings(workbench.experimentDocument, runtimeConsole.append)
  const experimentDataReadable = auth.isAuthenticated || workbench.experimentIsDemo
  const calculationAccess = calculationAccessPolicy({
    dataReadable: experimentDataReadable,
    experimentIsDemo: workbench.experimentIsDemo,
    experimentManageable: workbench.experimentManageable,
  })
  const [viewerCalculationSource, setViewerCalculationSource] = useState<string | undefined>()
  const [calculationDirty, setCalculationDirty] = useState(false)
  const [calculationSaveCommand, setCalculationSaveCommand] = useState(0)
  const [calculationSaveState, setCalculationSaveState] = useState<CalculationSaveState>({
    disabled: true,
    disabledReason: 'Calculation Editor를 불러오는 중입니다.',
  })
  const page = useCaePageSession(workbench, {
    authPending: auth.isPending,
    queryScope: auth.queryScope,
    hasUnsavedCalculationWork: calculationDirty,
  })
  const viewerCaptureRef = useRef<HTMLDivElement | null>(null)
  const saveWorkflow = useExperimentSaveWorkflow(workbench, preflight, viewerCaptureRef, page.setDialog)
  const setLayout = page.setLayout
  const { inspectedBatchId } = useCaeBatches()
  useCaeBatchConsole(runtimeConsole, page.bottomMode === 'console')
  useEffect(() => {
    if (!inspectedBatchId) return
    navigate('/settings')
  }, [inspectedBatchId, navigate])
  const currentSection = page.activeSection
  const guardReplacement = page.guardReplacement
  const [experimentAuthoringState, setExperimentAuthoringState] = useState<CadEditorAuthoringState | null>(null)
  const [analysisSettingsContainer, setAnalysisSettingsContainer] = useState<HTMLDivElement | null>(null)
  const [predictionVarsContainer, setPredictionVarsContainer] = useState<HTMLDivElement | null>(null)
  const [analysisCommand, setAnalysisCommand] = useState<AnalysisCommand | null>(null)
  const [predictionCommand, setPredictionCommand] = useState<PredictionWorkspaceCommand | null>(null)
  const [predictionViewer, setPredictionViewer] = useState<PredictionViewerState | null>(null)
  const [predictionState, setPredictionState] = useState<PredictionWorkspaceChromeState>({
    busy: false,
    canSample: false,
    canValidate: false,
    direction: 'forward',
    status: 'Prediction을 준비하는 중입니다.',
    validateDisabledReason: 'Prediction 결과가 필요합니다.',
  })
  const [predictionActivated, setPredictionActivated] = useState(false)
  const [measurementActivated, setMeasurementActivated] = useState(false)
  const commandSequence = useRef(0)
  const selectionSourceFiles =
    workbench.experiment?.kind === 'experiment' ? workbench.experiment.sourceBundle.files : null
  const {
    closeSourcePathPicker,
    findSelectionSource,
    handleCodeSelectionQueryChange,
    handleSelectionSourcePathsChange,
    handleSourceRevealRequestHandled,
    handleViewerSelectionQueryChange,
    revealSourceLocation,
    selectionQuery: viewerSelectionQuery,
    selectionSourceStatus,
    sourcePathPicker,
    sourceRevealRequest,
  } = useSelectionSourceNavigation({
    activeSection: currentSection,
    calculationDirty,
    files: selectionSourceFiles,
    guardReplacement,
    setLayout,
    workspaceSession: workbench.workspaceSession,
  })

  useEffect(() => {
    if (page.activeSection === 'prediction') setPredictionActivated(true)
    if (page.activeSection === 'measurement') setMeasurementActivated(true)
  }, [page.activeSection])

  useEffect(() => {
    if (page.activeSection !== 'analysis') setAnalysisCommand(null)
    if (page.activeSection !== 'prediction') setPredictionCommand(null)
  }, [page.activeSection])

  const setActiveSection = useCallback(
    (nextSection: WorkbenchSectionId) => {
      const changeSection = () => {
        setLayout((current) => ({ ...current, activeSection: nextSection }))
      }
      if (currentSection === 'calculation' && nextSection !== 'calculation' && calculationDirty) {
        guardReplacement(changeSection)
      } else {
        changeSection()
      }
    },
    [calculationDirty, currentSection, guardReplacement, setLayout],
  )

  const setAnalysisTab = useCallback(
    (analysisTab: AnalysisTabId) => setLayout((current) => ({ ...current, analysisTab })),
    [setLayout],
  )
  const requestAnalysisCommand = useCallback((type: AnalysisRibbonCommand) => {
    setAnalysisCommand({ id: ++commandSequence.current, type })
  }, [])
  const requestPredictionCommand = useCallback((type: PredictionRibbonCommand, sampleCount?: number) => {
    setPredictionCommand({ id: ++commandSequence.current, type, sampleCount })
  }, [])
  const requestCalculationSave = useCallback(() => {
    setCalculationSaveCommand((current) => current + 1)
  }, [])
  const requestAccount = useCallback(() => {
    const returnTo = `${location.pathname}${location.search}`
    navigate(`/account?returnTo=${encodeURIComponent(returnTo)}`)
  }, [location.pathname, location.search, navigate])

  const chrome = useCaePageChrome({
    analysisTab: page.analysisTab,
    authenticated: auth.isAuthenticated,
    dataReadable: experimentDataReadable,
    calculationDirty,
    calculationSaveState,
    experimentAuthoringState,
    guardReplacement: page.guardReplacement,
    requestAccount,
    requestAnalysisCommand,
    requestCalculationSave,
    requestPredictionCommand,
    selectedCalculationId: workbench.selectionContext.calculationId,
    requestRunSelected: page.requestRunSelected,
    runSafely: page.runSafely,
    setActiveSection,
    setAnalysisTab,
    setDialog: page.setDialog,
    workbench,
    predictionState,
    requestExperimentSave: () => {
      void saveWorkflow.save()
    },
    requestExperimentSaveAs: () => {
      void saveWorkflow.saveAs()
    },
    fileBusy: saveWorkflow.busy || preflight.busy,
    preflightControls: (
      <div className="flex items-center gap-2 px-2 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={saveWorkflow.includePreflight && Boolean(saveWorkflow.preflightId)}
            disabled={!saveWorkflow.preflightId || saveWorkflow.busy}
            onChange={(event) => saveWorkflow.setIncludePreflight(event.target.checked)}
          />
          Preflight 결과 함께 저장
        </label>
        <button
          type="button"
          className="rounded border px-3 py-1"
          disabled={
            preflight.busy || !workbench.experimentDocument.measurement || workbench.experimentDocument.runIsBusy
          }
          onClick={() => {
            if (!auth.isAuthenticated) requestAccount()
            else void preflight.run()
          }}
        >
          실행
        </button>
        <button
          type="button"
          className="rounded border px-3 py-1"
          disabled={preflight.busy || !workbench.experiment || workbench.experimentDocument.runIsBusy}
          onClick={() => {
            if (!auth.isAuthenticated) requestAccount()
            else void preflight.run(true)
          }}
        >
          Candidate 재생성 + 실행
        </button>
        {preflight.result ? (
          <button type="button" onClick={preflight.clear}>
            임시 결과 닫기
          </button>
        ) : null}
        {preflight.busy ? (
          <button type="button" onClick={() => void preflight.cancel()}>
            취소
          </button>
        ) : null}
      </div>
    ),
  })

  const activeFlatRecordedData = workbench.selection.flatRecordedData
  const activeRecordedRules = workbench.selection.recordedRules

  const leftPane =
    page.activeSection === 'experiment' ? null : page.activeSection === 'calculation' ? null : page.activeSection ===
      'prediction' ? (
      <div
        key="prediction-vars"
        className="h-full min-h-0 overflow-hidden bg-background p-2"
        ref={setPredictionVarsContainer}
      />
    ) : page.activeSection === 'analysis' ? (
      <div
        key="analysis-settings"
        className="h-full min-h-0 overflow-auto bg-background"
        ref={setAnalysisSettingsContainer}
      />
    ) : null

  const contextualRightPane =
    page.activeSection === 'experiment' ? (
      <div aria-label="Experiment source workspace" className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <div className="min-h-0 w-full min-w-0 flex-1">
          <ExperimentEditor
            controller={workbench.experimentDocument}
            disabled={
              !page.initialized ||
              saveWorkflow.busy ||
              Boolean(workbench.experimentRecord && !workbench.experimentManageable) ||
              workbench.measurementActions.busy ||
              workbench.calculationDataActions.busy ||
              workbench.saving !== null
            }
            document={workbench.experiment?.kind === 'experiment' ? workbench.experiment : null}
            initialActiveFile={page.activeExperimentFile}
            onActiveFileChange={page.setActiveExperimentFile}
            onAuthoringStateChange={setExperimentAuthoringState}
            onSourceRevealRequestHandled={handleSourceRevealRequestHandled}
            onViewerSelectionQueryChange={handleCodeSelectionQueryChange}
            sourceRevealRequest={sourceRevealRequest}
          />
        </div>
      </div>
    ) : page.activeSection === 'calculation' || page.activeSection === 'prediction' ? null : page.activeSection ===
      'analysis' ? (
      <Suspense fallback={<PaneLoading label="Analysis를 불러오는 중입니다." />}>
        <AnalysisWorkspace
          command={analysisCommand}
          dataReadable={experimentDataReadable}
          embedded
          experimentId={workbench.experimentId}
          settingsContainer={analysisSettingsContainer}
          selectedMeasurementId={workbench.selection.measurement?.id ?? null}
          tab={page.analysisTab}
          onRequestLogin={requestAccount}
          onSelectMeasurement={(measurementId) =>
            page.runSafely(async () => {
              const row = await workbench.selection.loadMeasurement(measurementId, workbench.experimentId)
              if (row && preflight.result) preflight.clear()
            })
          }
          onTabChange={setAnalysisTab}
        />
      </Suspense>
    ) : null

  const rightPane = (
    <div className="h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden">
      <div
        className={page.activeSection === 'prediction' ? 'hidden' : 'h-full min-h-0'}
        hidden={page.activeSection === 'prediction'}
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
              dataReadable={experimentDataReadable}
              command={predictionCommand}
              onActivity={runtimeConsole.append}
              onChromeStateChange={setPredictionState}
              onViewerStateChange={setPredictionViewer}
              onExperimentChange={(row) =>
                page.guardReplacement(async () => {
                  await workbench.loadExperiment(row)
                  page.setLayout((current) => ({ ...current, activeSection: 'prediction' }))
                })
              }
              onRequestLogin={requestAccount}
              selectedCalculationId={workbench.selectionContext.calculationId}
              varsContainer={predictionVarsContainer}
              workbench={workbench}
            />
          </Suspense>
        </div>
      ) : null}
    </div>
  )

  const isPrediction = page.activeSection === 'prediction'
  const preview = isPrediction ? null : preflight.result
  const predictionResult =
    isPrediction &&
    predictionViewer !== null &&
    predictionViewer.experimentId === workbench.experimentId &&
    predictionViewer.varsFingerprint === varsFingerprint(workbench.candidateVars) &&
    predictionViewer.sourceHash ===
      (workbench.experimentDocument.predictionCandidate?.sourceHash ??
        workbench.experimentDocument.evaluatedSnapshot?.sourceHash)
      ? predictionViewer
      : null
  const predictionContracts = Object.fromEntries(
    Object.entries(predictionResult?.preview.resultContracts ?? {}).filter(
      ([name, contract]) => contract.visualization.kind === 'box-grid' && predictionResult?.preview.recorded[name],
    ),
  )
  const viewerPane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <WorkbenchViewer
          onGeometryRequiredChange={isPrediction ? workbench.setPredictionGeometryRequired : undefined}
          initialDefaults={workbench.experimentRecord?.viewer_defaults}
          presentation={
            workbench.viewerPresentation
              ? {
                  ...workbench.viewerPresentation,
                  canSaveInitialView: workbench.viewerPresentation.canSaveInitialView && !isPrediction && !preview,
                }
              : undefined
          }
          persistenceKey={
            isPrediction
              ? `prediction:${workbench.experimentId}:${workbench.experimentDocument.resultSessionKey}`
              : undefined
          }
          resultPlaceholder={isPrediction && !predictionResult ? `BoxGrid 예측 · ${predictionState.status}` : undefined}
          calculationSource={isPrediction ? undefined : viewerCalculationSource}
          captureRef={viewerCaptureRef}
          activeExperimentTaskName={page.activeExperimentFile}
          experiment={preview?.experiment ?? workbench.experiment}
          experimentDocument={preview?.document ?? workbench.experimentDocument}
          onFindSelectionSource={findSelectionSource}
          onSelectionQueryChange={handleViewerSelectionQueryChange}
          onSelectionSourcePathsChange={handleSelectionSourcePathsChange}

          key={`${workbench.experimentId ?? ''}:${workbench.experimentDocument.resultSessionKey ?? ''}:${preflight.viewerEpoch}`}
          autoSelectResult={isPrediction || Boolean(preview || workbench.selection.measurement)}
          resultContracts={
            isPrediction
              ? predictionContracts
              : (preview?.payload.result_contracts ?? workbench.selection.resultContracts)
          }
          visualizations={isPrediction ? {} : (preview?.payload.visualizations ?? workbench.selection.visualizations)}
          resultErrors={isPrediction ? {} : (preview?.errors ?? workbench.selection.resultErrors)}
          resultSourceHash={
            isPrediction
              ? predictionResult?.sourceHash
              : (preview?.payload.source_hash ?? workbench.selection.materialSnapshot?.sourceHash)
          }
          resultVarsHash={
            isPrediction
              ? predictionResult?.varsHash
              : (preview?.payload.vars_hash ?? workbench.selection.materialSnapshot?.varsHash)
          }
          recordedData={
            isPrediction ? predictionResult?.preview.recorded : (preview?.data ?? workbench.selection.flatRecordedData)
          }
          recordedRules={
            isPrediction ? predictionResult?.preview.rules : (preview?.rules ?? workbench.selection.recordedRules)
          }
          loading={isPrediction ? false : !preview && (workbench.selection.loading || workbench.selectionRestoring)}
          downloadProgress={workbench.selection.downloadProgress}
          selectionQuery={viewerSelectionQuery}
          selectionSourceStatus={selectionSourceStatus}
        />
      </div>
    </div>
  )
  const menubar = (
    <WorkbenchMenubar
      activeSectionId={page.activeSection}
      sections={defaultWorkbenchSections}
      onActiveSectionChange={setActiveSection}
    />
  )
  const ribbon = <WorkbenchRibbon activeSectionId={page.activeSection} panels={chrome.ribbonPanels} />
  const bottomDock = (
    <WorkbenchBottomDock
      mode={page.bottomMode}
      onModeChange={(bottomMode) => page.setLayout((current) => ({ ...current, bottomMode }))}
      console={<RuntimeConsoleView store={runtimeConsole} />}
      summary={<RuntimeConsoleSummary store={runtimeConsole} />}
    />
  )

  return (
    <main className="flex h-full min-h-[560px] min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WorkbenchConsoleLayout
        console={bottomDock}
        heightRatio={page.layout.bottomHeightRatio}
        mode={page.bottomMode}
        onHeightRatioChange={(bottomHeightRatio) => page.setLayout((current) => ({ ...current, bottomHeightRatio }))}
      >
        <div aria-busy={!page.initialized} className="relative h-full min-h-0" inert={!page.initialized}>
          {measurementActivated ? (
            <div
              className={page.activeSection === 'measurement' ? 'h-full min-h-0' : 'hidden'}
              hidden={page.activeSection !== 'measurement'}
            >
              <MeasurementWorkspace
                key={`${workbench.workspaceSession}:${JSON.stringify(workbench.experiment?.sourceBundle)}`}
                workbench={workbench}
                authenticated={auth.isAuthenticated}
                dataReadable={experimentDataReadable}
                active={page.activeSection === 'measurement'}
                menubar={menubar}
                onActivity={runtimeConsole.append}
              />
            </div>
          ) : null}
          <div
            className={page.activeSection === 'measurement' ? 'hidden' : 'h-full min-h-0'}
            hidden={page.activeSection === 'measurement'}
          >
            {page.activeSection === 'experiment' ? (
              <ExperimentWorkspace menubar={menubar} ribbon={ribbon} viewer={viewerPane} editor={rightPane} />
            ) : page.activeSection === 'calculation' ? (
              <CalculationWorkbenchContainer
                onSourceChange={setViewerCalculationSource}
                authenticated={auth.isAuthenticated}
                dataReadable={experimentDataReadable}
                busy={workbench.measurementActions.busy || workbench.calculationDataActions.busy}
                calculationDataBusy={workbench.calculationDataActions.busy}
                contextPending={workbench.selectionRestoring}
                persistable={calculationAccess.persistable}
                sourceEditable={calculationAccess.sourceEditable}
                experimentId={workbench.experimentId}
                measurementId={workbench.selection.measurement?.id ?? null}
                measurementLoading={workbench.selection.loading}
                measurementSelectionPending={workbench.selectionRestoring}
                menubar={menubar}
                onActivity={runtimeConsole.append}
                onCalculationSelectionChange={workbench.selectCalculation}
                onDeleteMeasurements={workbench.measurementActions.deleteMeasurements}
                onDirtyChange={setCalculationDirty}
                onRequestLogin={requestAccount}
                onSaveStateChange={setCalculationSaveState}
                onSelectMeasurement={(row) => page.runSafely(() => workbench.selection.loadMeasurement(row))}
                onClearMeasurement={workbench.selection.clearMeasurement}
                onUsageChanged={workbench.refreshExperimentUsage}
                publicDemoMutable={workbench.experimentIsDemo && workbench.experimentManageable}
                recordedData={activeFlatRecordedData}
                recordedRules={activeRecordedRules}
                ribbon={(controls) => (
                  <WorkbenchRibbon
                    activeSectionId="calculation"
                    panels={chrome.ribbonPanels.map((panel) =>
                      panel.sectionId === 'calculation'
                        ? {
                            ...panel,
                            content: (
                              <>
                                {controls}
                                {panel.content}
                              </>
                            ),
                          }
                        : panel,
                    )}
                  />
                )}
                saveCommand={calculationSaveCommand}
                selectedCalculationId={workbench.selectionContext.calculationId}
                viewer={viewerPane}
              />
            ) : (
              <WorkbenchShellContainer
                className="h-full min-h-0"
                left={leftPane}
                leftLabel={`${page.activeSection} 목록 및 설정`}
                menubar={menubar}
                ribbon={ribbon}
                right={rightPane}
                rightLabel={`${page.activeSection} Detail`}
                viewer={viewerPane}
              />
            )}
          </div>
          {!page.initialized ? (
            <div
              aria-label="작업공간 복원 중"
              className="absolute inset-0 z-50 flex items-center justify-center bg-background/55 text-sm font-medium backdrop-blur-[1px]"
              role="status"
            >
              로컬 작업공간을 복원하는 중입니다.
            </div>
          ) : null}
        </div>
      </WorkbenchConsoleLayout>

      <CaeWorkbenchDialogs
        dialog={page.dialog}
        setDialog={page.setDialog}
        workbench={workbench}
        user={auth.user}
        saveWorkflow={saveWorkflow}
        guardReplacement={page.guardReplacement}
        onSaved={preflight.clear}
      />
      <SourcePathPickerDialog
        locations={sourcePathPicker?.locations ?? []}
        open={sourcePathPicker !== null}
        value={sourcePathPicker?.value ?? ''}
        onOpenChange={(open) => !open && closeSourcePathPicker()}
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

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <Rows3 className="mr-2 inline size-4 animate-pulse" />
      {label}
    </div>
  )
}
