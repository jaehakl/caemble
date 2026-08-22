import { Badge } from '@/components/ui/badge'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useLocation } from 'react-router'
import type { AiAgentApplyRequest } from '@/api/aiAgent'
import { useAuth } from '@/features/auth/use-auth'
import {
  EditorDock,
  WorkbenchMenubar,
  WorkbenchRibbon,
  WorkbenchShell,
  WorkbenchToolbar,
} from '@/features/cae-workbench/chrome'
import { ConfirmWorkbenchDialog } from '@/features/cae-workbench/dialogs'
import { ExperimentEditor, RecordedDataEditor } from '@/features/cae-workbench/editors'
import { ExperimentManager } from '@/features/cae-workbench/experiments'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { WorkbenchViewer } from '@/features/cae-workbench/viewer/WorkbenchViewer'
import type { RecordedDataRule } from '@/lib/cad'
import { NotFoundPage } from '@/pages/not-found/NotFoundPage'
import { CaeWorkbenchDialogs } from './CaeWorkbenchDialogs'
import { useCaePageChrome } from './useCaePageChrome'
import { caeWorkbenchTabs, useCaePageSession } from './useCaePageSession'

const AiHelperWorkspace = lazy(() =>
  import('@/pages/ai/AiHelperPage').then((module) => ({ default: module.AiHelperWorkspace })),
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
  const workbench = useCaeWorkbenchState(auth.user, auth.isAuthenticated)
  const page = useCaePageSession(workbench)
  const [experimentAuthoringState, setExperimentAuthoringState] = useState<CadEditorAuthoringState | null>(null)
  const chrome = useCaePageChrome({
    authenticated: auth.isAuthenticated,
    experimentAuthoringState,
    guardReplacement: page.guardReplacement,
    openTab: page.openTab,
    requestRunSelected: page.requestRunSelected,
    runSafely: page.runSafely,
    setDialog: page.setDialog,
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
      page.openTab('experiment')
    }
    return result
  }

  const tabs = caeWorkbenchTabs
    .filter((tab) => page.openTabs.includes(tab))
    .sort((left, right) => page.openTabs.indexOf(left) - page.openTabs.indexOf(right))
    .map((tab) => ({
      id: tab,
      label:
        tab === 'experiment'
          ? 'Experiment'
          : tab === 'experiments'
            ? 'Experiments'
            : tab === 'recorded-data'
              ? 'RecordedData'
              : 'AI Helper',
      content:
        tab === 'experiment' ? (
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
        ) : tab === 'experiments' ? (
          <ExperimentManager
            authenticated={auth.isAuthenticated}
            busy={workbench.saving !== null || workbench.measurementActions.busy}
            selectedId={workbench.experimentId}
            user={auth.user}
            onDeleteSelected={workbench.detachDeletedExperiment}
            onOpenSaved={(row) =>
              page.guardReplacement(async () => {
                await workbench.loadExperiment(row)
                page.openTab('experiment')
              })
            }
            onOpenExample={(sourceBundle, name, description) =>
              page.guardReplacement(() => {
                workbench.newExperiment(sourceBundle, name, description)
                page.openTab('experiment')
              })
            }
          />
        ) : tab === 'recorded-data' ? (
          <RecordedDataEditor
            measurementId={workbench.selection.measurement?.id ?? null}
            pendingSave={pendingResult}
            recordedAt={workbench.selection.measurement?.recorded_at ?? null}
            recordedData={pendingResult ? workbench.simulation.recordedData : workbench.selection.recordedData}
            rules={pendingResult ? sessionRecordedRules : workbench.selection.recordedRules}
          />
        ) : (
          <Suspense
            fallback={<div className="grid h-full place-items-center text-sm">AI Helper를 불러오는 중입니다.</div>}
          >
            <AiHelperWorkspace
              activeExperimentFile={page.activeExperimentFile}
              activeTab={page.activeTab}
              baseHash={workbench.agentWorkspaceIdentity?.baseHash}
              experimentContextVersion={workbench.agentWorkspaceIdentity?.experimentContextVersion}
              workbench={workbench}
              onApplyStagedBundle={applyAgentBundle}
              onRequestLogin={() => page.setDialog('account')}
            />
          </Suspense>
        ),
    }))

  const closeTab = (tabId: string) => {
    const next = page.openTabs.filter((tab) => tab !== tabId)
    page.setOpenTabs(next)
    if (page.activeTab === tabId) page.setActiveTab(next[0] ?? 'experiment')
  }

  return (
    <main className="flex h-dvh min-h-[560px] min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div aria-busy={!page.initialized} className="relative min-h-0 flex-1" inert={!page.initialized}>
        <WorkbenchShell
          className="h-full min-h-0"
          editor={
            <EditorDock
              activeTabId={page.openTabs.includes(page.activeTab) ? page.activeTab : null}
              tabs={tabs}
              onActiveTabChange={(id) => page.setActiveTab(id as WorkbenchTabId)}
              onTabClose={closeTab}
              onTabsReorder={(ids) => page.setOpenTabs(ids as WorkbenchTabId[])}
            />
          }
          menubar={<WorkbenchMenubar menus={chrome.menus} />}
          mobileViewerOpen={page.mobileViewerOpen}
          ribbon={
            <WorkbenchRibbon
              activeTabId={page.openTabs.includes(page.activeTab) ? page.activeTab : null}
              panels={chrome.ribbonPanels}
            />
          }
          toolbar={<WorkbenchToolbar actions={chrome.toolbar} />}
          viewer={
            <WorkbenchViewer
              activeExperimentTaskName={page.activeExperimentFile}
              activeTab={page.activeTab}
              experiment={workbench.experiment}
              experimentDocument={workbench.experimentDocument}
            />
          }
          viewerPercent={page.viewerPercent}
          onMobileViewerOpenChange={page.setMobileViewerOpen}
          onViewerPercentChange={page.setViewerPercent}
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

      <CaeWorkbenchDialogs
        dialog={page.dialog}
        runSafely={page.runSafely}
        setDialog={page.setDialog}
        workbench={workbench}
      />
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

export const Component = CaePage
