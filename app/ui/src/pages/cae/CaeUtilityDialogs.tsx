import { lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchTabId } from '@/features/cae-workbench/types'
import type { WorkbenchDialog } from './caePageTypes'

const AccountWorkspace = lazy(() =>
  import('@/pages/account/AccountPage').then((module) => ({ default: module.AccountWorkspace })),
)
const AiChatWorkspace = lazy(() =>
  import('@/pages/ai/AiChatPage').then((module) => ({ default: module.AiChatWorkspace })),
)
const AiHelperWorkspace = lazy(() =>
  import('@/pages/ai/AiHelperPage').then((module) => ({ default: module.AiHelperWorkspace })),
)
const JobsWorkspace = lazy(() => import('@/pages/jobs/JobsPage').then((module) => ({ default: module.JobsWorkspace })))
const LaunchersWorkspace = lazy(() =>
  import('@/pages/launchers/LaunchersPage').then((module) => ({ default: module.LaunchersWorkspace })),
)

export function CaeUtilityDialogs({
  activeExperimentFile,
  activeTab,
  dialog,
  setDialog,
  workbench,
}: {
  activeExperimentFile: string | null
  activeTab: WorkbenchTabId
  dialog: WorkbenchDialog
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  workbench: CaeWorkbenchState
}) {
  const requestLogin = () => setDialog('account')
  return (
    <>
      <UtilityDialog
        contentClassName="sm:max-w-4xl"
        description="Docs와 현재 Workbench를 바탕으로 CAE 작업을 도와줍니다."
        dialog={dialog}
        id="ai-helper"
        title="AI Helper"
        setDialog={setDialog}
      >
        <AiHelperWorkspace
          activeExperimentFile={activeExperimentFile}
          activeTab={activeTab}
          workbench={workbench}
          onRequestLogin={requestLogin}
        />
      </UtilityDialog>
      <UtilityDialog
        contentClassName="sm:max-w-4xl"
        description="로컬 LLM과 대화합니다."
        dialog={dialog}
        id="ai-chat"
        title="AI Chat"
        setDialog={setDialog}
      >
        <AiChatWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        contentClassName="sm:max-w-7xl"
        description="연결된 Launcher와 worker 상태를 관리합니다."
        dialog={dialog}
        id="launchers"
        title="Launchers"
        setDialog={setDialog}
      >
        <LaunchersWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        contentClassName="sm:max-w-7xl"
        description="CAE 및 AI Job 실행 이력을 확인합니다."
        dialog={dialog}
        id="jobs"
        title="Jobs"
        setDialog={setDialog}
      >
        <JobsWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        contentClassName="sm:max-w-6xl"
        description="계정과 Access Token을 관리합니다."
        dialog={dialog}
        id="account"
        title="Account"
        setDialog={setDialog}
      >
        <AccountWorkspace />
      </UtilityDialog>
    </>
  )
}

function UtilityDialog({
  children,
  contentClassName,
  description,
  dialog,
  id,
  setDialog,
  title,
}: {
  children: ReactNode
  contentClassName: string
  description: string
  dialog: WorkbenchDialog
  id: Exclude<WorkbenchDialog, null>
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  title: string
}) {
  const open = dialog === id
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && setDialog(null)}>
      <DialogContent
        className={`grid h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 ${contentClassName}`}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-auto">
          {open ? (
            <Suspense
              fallback={<div className="flex min-h-80 items-center justify-center text-sm">불러오는 중입니다.</div>}
            >
              {children}
            </Suspense>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
