import { usePreflight } from '@/features/measurement/usePreflight'
import { Rows3 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import { NotFoundView } from '@/features/error/NotFoundView'
import {
  defaultWorkbenchSections,
  WorkbenchBottomDock,
  WorkbenchMenubar,
  WorkbenchRibbon,
} from '@/features/cae-workbench/chrome'
import { ConfirmWorkbenchDialog } from '@/features/cae-workbench/dialogs'
import { ExperimentEditor, SourcePathPickerDialog } from '@/features/cae-workbench/editors'
import { useExperimentSaveWorkflow } from '@/features/experiment/useExperimentSaveWorkflow'
import { ExperimentWorkspace } from '@/features/cae-workbench/chrome/ExperimentWorkspace'
import { calculationAccessPolicy, type CalculationSaveState } from '@/features/calculation'
import type {
  PredictionWorkspaceChromeState,
  PredictionWorkspaceCommand,
} from '@/features/prediction/PredictionWorkspace'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { createRuntimeConsoleStore, RuntimeConsoleView } from '@/features/runtime-console'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { useSelectionSourceNavigation } from '@/features/cae-workbench/viewer/useSelectionSourceNavigation'
import { WorkbenchShellProvider } from '@/workbench/state/workbenchShellStore'
import { CalculationWorkbenchContainer } from '@/workbench/CalculationWorkbenchContainer'
import { WorkbenchShellContainer } from '@/workbench/WorkbenchShellContainer'
import type { AnalysisCommand } from '@/features/analysis/AnalysisPage'
import { useCaeBatches } from '@/features/cae/CaeBatchProvider'
import { useCaeBatchConsole } from '@/features/cae/useCaeBatchConsole'
import { CaeWorkbenchDialogs } from '@/features/cae-workbench/CaeWorkbenchDialogs'
import { ExperimentDetail } from '@/features/cae-workbench/WorkbenchDetails'
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
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated, { onActivity: runtimeConsole.append })
  const preflight = usePreflight(
    workbench.experiment,
    workbench.experimentDocument,
    `${workbench.experimentId ?? ''}:${workbench.experimentDocument.resultSessionKey ?? ''}:${workbench.selection.measurement?.id ?? ''}`,
  )
  const experimentDataReadable = auth.isAuthenticated || workbench.experimentIsDemo
  const calculationAccess = calculationAccessPolicy({
    dataReadable: experimentDataReadable,
    experimentIsDemo: workbench.experimentIsDemo,
    experimentManageable: workbench.experimentManageable,
  })
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
  const [predictionState, setPredictionState] = useState<PredictionWorkspaceChromeState>({
    busy: false,
    canSample: false,
    canValidate: false,
    direction: 'forward',
    status: 'Prediction을 준비하는 중입니다.',
    validateDisabledReason: 'Prediction 결과가 필요합니다.',
  })
  const [predictionActivated, setPredictionActivated] = useState(false)
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
      if (currentSection === 'measurement' && nextSection !== 'measurement' && calculationDirty) {
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
    page.activeSection === 'experiment' ? null : page.activeSection === 'measurement' ? null : page.activeSection ===
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
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b p-2 text-xs">
          {preflight.result ? (
            <button type="button" onClick={preflight.clear}>
              임시 결과 닫기
            </button>
          ) : null}
          <span role="status">{preflight.status}</span>
          {preflight.error ? (
            <span role="alert" className="text-red-700">
              {preflight.error}
            </span>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
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
              ),
              detail: <ExperimentDetail workbench={workbench} />,
            }}
          />
        </div>
      </div>
    ) : page.activeSection === 'measurement' || page.activeSection === 'prediction' ? null : page.activeSection ===
      'analysis' ? (
      <Suspense fallback={<PaneLoading label="Analysis를 불러오는 중입니다." />}>
        <AnalysisWorkspace
          command={analysisCommand}
          dataReadable={experimentDataReadable}
          embedded
          experimentId={workbench.experimentId}
          settingsContainer={analysisSettingsContainer}
          tab={page.analysisTab}
          onRequestLogin={requestAccount}
          onTabChange={setAnalysisTab}
        />
      </Suspense>
    ) : null

  const rightPane = (
    <div className="h-full min-h-0 overflow-hidden">
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

  const preview = preflight.result
  const viewerPane = (
    <div className="flex h-full min-h-0 flex-col">
      {preview ? <div className="border-b p-2 text-xs">임시 결과 · 실행 당시 Geometry / Vars</div> : null}
      <div className="min-h-0 flex-1">
        <WorkbenchViewer
          captureRef={viewerCaptureRef}
          activeExperimentTaskName={page.activeExperimentFile}
          experiment={preview?.experiment ?? workbench.experiment}
          experimentDocument={preview?.document ?? workbench.experimentDocument}
          onFindSelectionSource={findSelectionSource}
          onSelectionQueryChange={handleViewerSelectionQueryChange}
          onSelectionSourcePathsChange={handleSelectionSourcePathsChange}
          onToggleViewerExpanded={() =>
            page.setLayout((current) => ({ ...current, viewerExpanded: !current.viewerExpanded }))
          }
          key={`${workbench.experimentId ?? ''}:${workbench.experimentDocument.resultSessionKey ?? ''}:${preflight.viewerEpoch}`}
          autoSelectResult={Boolean(preview || workbench.selection.measurement)}
          resultContracts={preview?.payload.result_contracts ?? workbench.selection.resultContracts}
          visualizations={preview?.payload.visualizations ?? workbench.selection.visualizations}
          resultErrors={preview?.errors ?? workbench.selection.resultErrors}
          resultSourceHash={preview?.payload.source_hash ?? workbench.selection.materialSnapshot?.sourceHash}
          resultVarsHash={preview?.payload.vars_hash ?? workbench.selection.materialSnapshot?.varsHash}
          recordedData={preview?.data ?? workbench.selection.flatRecordedData}
          recordedRules={preview?.rules ?? workbench.selection.recordedRules}
          loading={!preview && workbench.selection.loading}
          downloadProgress={workbench.selection.downloadProgress}
          selectionQuery={viewerSelectionQuery}
          selectionSourceStatus={selectionSourceStatus}
          viewerExpanded={page.viewerExpanded}
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
    />
  )

  return (
    <main className="flex h-full min-h-[560px] min-w-[1280px] flex-col overflow-hidden bg-background text-foreground">
      <div aria-busy={!page.initialized} className="relative min-h-0 flex-1" inert={!page.initialized}>
        <div className="h-full min-h-0">
          {page.activeSection === 'experiment' ? (
            <ExperimentWorkspace
              menubar={menubar}
              ribbon={ribbon}
              viewer={viewerPane}
              editor={rightPane}
              bottom={bottomDock}
              expanded={page.viewerExpanded}
              bottomVisible={page.bottomMode !== 'hidden'}
              bottomRatio={page.layout.bottomHeightRatio}
              onBottomRatioChange={(bottomHeightRatio) =>
                page.setLayout((current) => ({ ...current, bottomHeightRatio }))
              }
            />
          ) : page.activeSection === 'measurement' ? (
            <CalculationWorkbenchContainer
              authenticated={auth.isAuthenticated}
              dataReadable={experimentDataReadable}
              bottom={bottomDock}
              busy={workbench.measurementActions.busy || workbench.calculationDataActions.busy}
              calculationDataBusy={workbench.calculationDataActions.busy}
              candidateEditingDisabled={workbench.measurementActions.busy || workbench.calculationDataActions.busy}
              candidateSessionKey={`${workbench.experimentId ?? 'none'}`}
              candidateVars={workbench.candidateVars}
              contextPending={workbench.selectionRestoring}
              persistable={calculationAccess.persistable}
              sourceEditable={calculationAccess.sourceEditable}
              experimentId={workbench.experimentId}
              measurementId={workbench.selection.measurement?.id ?? null}
              measurementLoading={workbench.selection.loading}
              measurementSelectionPending={workbench.selectionRestoring}
              menubar={menubar}
              onActivity={runtimeConsole.append}
              onCandidateVariableChange={workbench.setCandidateVariable}
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
              ribbon={ribbon}
              saveCommand={calculationSaveCommand}
              selectedCalculationId={workbench.selectionContext.calculationId}
              varsSchema={workbench.experimentDocument.varsSchema}
              viewer={viewerPane}
            />
          ) : (
            <WorkbenchShellContainer
              bottom={bottomDock}
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
      <footer className="flex h-7 shrink-0 items-center justify-between gap-3 overflow-hidden border-t bg-muted/35 px-3 text-[11px] whitespace-nowrap text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2 truncate">
          <Badge className="h-5 max-w-[38vw] truncate rounded-sm px-1.5 font-mono">
            {workbench.experimentCoordinate ?? 'local Experiment'}
          </Badge>
          {workbench.experimentVersion ? (
            <Badge className="h-5 rounded-sm px-1.5">v{workbench.experimentVersion}</Badge>
          ) : null}
          {workbench.experimentIsDemo ? (
            <Badge className="h-5 rounded-sm bg-primary px-1.5 text-primary-foreground">
              {workbench.experimentManageable
                ? 'Demo · 관리자 편집 가능'
                : page.activeSection === 'measurement'
                  ? 'Demo · 원본 데이터 읽기 전용 · Calculation 로컬 미리보기'
                  : 'Demo · 읽기 전용'}
            </Badge>
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
            {workbench.selection.measurement
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

function PaneLoading({ label }: { label: string }) {
  return (
    <div className="grid h-full place-items-center text-sm text-muted-foreground">
      <Rows3 className="mr-2 inline size-4 animate-pulse" />
      {label}
    </div>
  )
}
