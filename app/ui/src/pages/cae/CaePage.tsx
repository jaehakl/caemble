import { useQueryClient } from '@tanstack/react-query'
import { Bot, Database, Rows3 } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import type { AiAgentApplyRequest } from '@/api/aiAgent'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/use-auth'
import { WorkbenchBottomDock, WorkbenchMenubar, WorkbenchRibbon, WorkbenchShell } from '@/features/cae-workbench/chrome'
import { ConfirmWorkbenchDialog } from '@/features/cae-workbench/dialogs'
import { ExperimentEditor, RecordedDataEditor } from '@/features/cae-workbench/editors'
import { ExperimentManager } from '@/features/cae-workbench/experiments'
import { MeasurementDetail, MeasurementExplorer } from '@/features/cae-workbench/measurement'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { AnalysisTabId, HelpKindId, WorkbenchSectionId } from '@/features/cae-workbench/types'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import { createRuntimeConsoleStore, RuntimeConsoleView } from '@/features/runtime-console'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import type { RecordedDataRule } from '@/lib/cad'
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
  const page = useCaePageSession(workbench)
  const [experimentAuthoringState, setExperimentAuthoringState] = useState<CadEditorAuthoringState | null>(null)
  const [analysisSettingsContainer, setAnalysisSettingsContainer] = useState<HTMLDivElement | null>(null)
  const [chatSettingsContainer, setChatSettingsContainer] = useState<HTMLDivElement | null>(null)
  const [analysisCommand, setAnalysisCommand] = useState<AnalysisCommand | null>(null)
  const [chatCommand, setChatCommand] = useState<AiChatCommand | null>(null)
  const [materialCommand, setMaterialCommand] = useState<Readonly<{ id: number; type: MaterialRibbonCommand }> | null>(
    null,
  )
  const [agentActivated, setAgentActivated] = useState(false)
  const [labActivated, setLabActivated] = useState(false)
  const commandSequence = useRef(0)
  const selectedMaterialId = page.materialId

  useEffect(() => {
    if (page.bottomMode === 'agent') setAgentActivated(true)
  }, [page.bottomMode])

  useEffect(() => {
    if (page.activeSection === 'lab') setLabActivated(true)
  }, [page.activeSection])

  useEffect(() => {
    if (page.activeSection !== 'analysis') setAnalysisCommand(null)
    if (page.activeSection !== 'lab') setChatCommand(null)
    if (page.activeSection !== 'material') setMaterialCommand(null)
  }, [page.activeSection])

  useEffect(() => {
    setMaterialCommand(null)
  }, [selectedMaterialId])

  const setActiveSection = useCallback(
    (activeSection: WorkbenchSectionId) => page.setLayout((current) => ({ ...current, activeSection })),
    [page],
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
  const refreshRuntime = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['runtime', 'launchers'] }),
      queryClient.invalidateQueries({ queryKey: ['runtime', 'jobs'] }),
    ])
  }, [queryClient])

  const chrome = useCaePageChrome({
    analysisTab: page.analysisTab,
    authenticated: auth.isAuthenticated,
    experimentAuthoringState,
    guardReplacement: page.guardReplacement,
    helpKind: page.help.kind,
    materialSelected: selectedMaterialId !== null,
    refreshRuntime,
    requestAnalysisCommand,
    requestLabCommand,
    requestMaterialCommand,
    requestRunSelected: page.requestRunSelected,
    runSafely: page.runSafely,
    setActiveSection,
    setAnalysisTab,
    setDialog: page.setDialog,
    setHelpKind,
    workbench,
  })

  const sessionRecordedRules = useMemo(
    () =>
      Object.entries(workbench.experimentDocument.simulationProgram?.recordedData ?? {}).map(
        ([label, result]) =>
          ({
            target: Object.freeze([]),
            label,
            methodId: 'measurement.session-recorded-data',
            parameters: Object.freeze({}),
            result,
          }) satisfies RecordedDataRule,
      ),
    [workbench.experimentDocument.simulationProgram],
  )
  const pendingResult = workbench.measurementActions.pendingRecordMeasurementId !== null

  const applyAgentBundle = async (request: AiAgentApplyRequest) => {
    const result = await workbench.applyAgentBundle(request)
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

  const leftPane =
    page.activeSection === 'experiment' ? (
      <ExperimentManager
        authenticated={auth.isAuthenticated}
        busy={workbench.saving !== null || workbench.measurementActions.busy}
        compact
        selectedId={workbench.experimentId}
        user={auth.user}
        onDeleteSelected={workbench.detachDeletedExperiment}
        onOpenSaved={(row) =>
          page.guardReplacement(async () => {
            await workbench.loadExperiment(row)
            setActiveSection('experiment')
          })
        }
        onOpenExample={(sourceBundle, name, description) =>
          page.guardReplacement(() => {
            workbench.newExperiment(sourceBundle, name, description)
            setActiveSection('experiment')
          })
        }
      />
    ) : page.activeSection === 'measurement' ? (
      <div className="flex h-full min-h-0 flex-col gap-3 p-3">
        <div>
          <h2 className="font-semibold">Measurements</h2>
          <p className="mt-1 text-xs text-muted-foreground">현재 Experiment의 Prepared·Recorded 조건</p>
        </div>
        <MeasurementExplorer
          enabled={auth.isAuthenticated}
          experimentId={workbench.experimentId}
          selectedId={workbench.selection.measurement?.id}
          onDuplicate={(row) => page.runSafely(() => workbench.measurementActions.duplicateMeasurement(row))}
          onSelect={(row) => page.runSafely(() => workbench.selection.loadMeasurement(row))}
        />
      </div>
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
                !page.initialized || pendingResult || workbench.measurementActions.busy || workbench.saving !== null
              }
              document={workbench.experiment?.kind === 'experiment' ? workbench.experiment : null}
              initialActiveFile={page.activeExperimentFile}
              onActiveFileChange={page.setActiveExperimentFile}
              onAuthoringStateChange={setExperimentAuthoringState}
              onUndoAgentChange={workbench.undoAgentChange}
            />
          ),
          detail: <ExperimentDetail workbench={workbench} />,
        }}
      />
    ) : page.activeSection === 'measurement' ? (
      <PaneTabs
        label="Measurement"
        options={[
          { id: 'recorded-data', label: 'Recorded Data' },
          { id: 'detail', label: 'Detail' },
        ]}
        value={page.rightTabs.measurement}
        onValueChange={(measurement) =>
          page.setLayout((current) => ({
            ...current,
            rightTabs: { ...current.rightTabs, measurement: measurement as 'recorded-data' | 'detail' },
          }))
        }
        panels={{
          'recorded-data': (
            <RecordedDataEditor
              measurementId={workbench.selection.measurement?.id ?? null}
              pendingSave={pendingResult}
              recordedAt={workbench.selection.measurement?.recorded_at ?? null}
              recordedData={pendingResult ? workbench.simulation.recordedData : workbench.selection.recordedData}
              rules={pendingResult ? sessionRecordedRules : workbench.selection.recordedRules}
            />
          ),
          detail: (
            <MeasurementDetail
              measurement={workbench.selection.measurement}
              pendingSave={pendingResult}
              recordedRows={workbench.selection.recordedRows}
            />
          ),
        }}
      />
    ) : page.activeSection === 'material' ? (
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
        <PaneEmpty
          icon={<Database />}
          title="Material을 선택하세요"
          description="왼쪽 목록에서 Material Detail을 엽니다."
        />
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
      <div className={page.activeSection === 'lab' ? 'hidden' : 'h-full min-h-0'} hidden={page.activeSection === 'lab'}>
        {contextualRightPane}
      </div>
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

  return (
    <main className="flex h-dvh min-h-[560px] min-w-[1280px] flex-col overflow-hidden bg-background text-foreground">
      <div aria-busy={!page.initialized} className="relative min-h-0 flex-1" inert={!page.initialized}>
        <WorkbenchShell
          bottom={
            <WorkbenchBottomDock
              mode={page.bottomMode}
              onModeChange={(bottomMode) => page.setLayout((current) => ({ ...current, bottomMode }))}
              agent={
                agentActivated ? (
                  <Suspense fallback={<PaneLoading label="AI Agent를 불러오는 중입니다." />}>
                    <AiHelperWorkspace
                      activeExperimentFile={page.activeExperimentFile}
                      activeTab="ai-helper"
                      baseHash={workbench.agentWorkspaceIdentity?.baseHash}
                      experimentContextVersion={workbench.agentWorkspaceIdentity?.experimentContextVersion}
                      workbench={workbench}
                      onApplyStagedBundle={applyAgentBundle}
                      onRequestLogin={() => page.setDialog('account')}
                    />
                  </Suspense>
                ) : (
                  <PaneEmpty
                    icon={<Bot />}
                    title="AI Agent"
                    description="AI Agent 탭을 열면 현재 Experiment 문맥으로 시작합니다."
                  />
                )
              }
              console={<RuntimeConsoleView store={runtimeConsole} />}
            />
          }
          bottomHeightPx={page.bottomHeightPx}
          bottomMode={page.bottomMode}
          className="h-full min-h-0"
          left={leftPane}
          leftLabel={`${page.activeSection} 목록 및 설정`}
          leftWidthPx={page.leftWidthPx}
          menubar={<WorkbenchMenubar activeSectionId={page.activeSection} onActiveSectionChange={setActiveSection} />}
          ribbon={<WorkbenchRibbon activeSectionId={page.activeSection} panels={chrome.ribbonPanels} />}
          right={rightPane}
          rightLabel={`${page.activeSection} Detail`}
          rightWidthPx={page.rightWidthPx}
          viewer={
            <WorkbenchViewer
              activeExperimentTaskName={page.activeExperimentFile}
              experiment={workbench.experiment}
              experimentDocument={workbench.experimentDocument}
            />
          }
          onBottomHeightChange={(bottomHeightPx) => page.setLayout((current) => ({ ...current, bottomHeightPx }))}
          onLeftWidthChange={(leftWidthPx) => page.setLayout((current) => ({ ...current, leftWidthPx }))}
          onRightWidthChange={(rightWidthPx) => page.setLayout((current) => ({ ...current, rightWidthPx }))}
        />
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
          <span>{page.initialized ? '현재 브라우저 세션에 Draft 자동 저장' : '작업 복원 중…'}</span>
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
        ) : (
          <span>
            {auth.isAuthenticated
              ? auth.user?.display_name || auth.user?.email || 'Signed in'
              : 'Local editing · 서버 기능은 로그인 필요'}
          </span>
        )}
      </footer>

      <CaeWorkbenchDialogs dialog={page.dialog} setDialog={page.setDialog} workbench={workbench} />
      <ConfirmWorkbenchDialog
        confirmLabel={page.confirmation?.confirmLabel}
        description={page.confirmation?.description ?? ''}
        open={page.confirmation !== null}
        title={page.confirmation?.title ?? ''}
        onCancel={() => page.setConfirmation(null)}
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

function PaneEmpty({ description, icon, title }: { description: string; icon: ReactNode; title: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-xs text-muted-foreground [&_svg]:mx-auto [&_svg]:size-8">
        {icon}
        <p className="mt-3 font-medium text-foreground">{title}</p>
        <p className="mt-1 text-sm">{description}</p>
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
