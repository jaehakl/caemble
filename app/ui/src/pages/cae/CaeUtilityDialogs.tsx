import { lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { WorkbenchDialog } from './caePageTypes'

const AccountWorkspace = lazy(() =>
  import('@/pages/account/AccountPage').then((module) => ({ default: module.AccountWorkspace })),
)
const AiChatWorkspace = lazy(() =>
  import('@/pages/ai/AiChatPage').then((module) => ({ default: module.AiChatWorkspace })),
)
const GeometryCatalog = lazy(() =>
  import('@/pages/catalog/cad/CadCatalogPage').then((module) => ({ default: module.GeometryCatalog })),
)
const MaterialCatalog = lazy(() =>
  import('@/pages/catalog/materials/MaterialCatalogPage').then((module) => ({ default: module.MaterialCatalog })),
)
const QuantityCatalog = lazy(() =>
  import('@/pages/catalog/quantity-kinds/QuantityKindCatalogPage').then((module) => ({
    default: module.QuantityCatalog,
  })),
)
const PhysicsCatalog = lazy(() =>
  import('@/pages/catalog/solvers/SolverCatalogPage').then((module) => ({ default: module.PhysicsCatalog })),
)
const ManualWorkspace = lazy(() =>
  import('@/pages/docs/DocsPage').then((module) => ({ default: module.ManualWorkspace })),
)
const JobsWorkspace = lazy(() => import('@/pages/jobs/JobsPage').then((module) => ({ default: module.JobsWorkspace })))
const LaunchersWorkspace = lazy(() =>
  import('@/pages/launchers/LaunchersPage').then((module) => ({ default: module.LaunchersWorkspace })),
)

export function CaeUtilityDialogs({
  dialog,
  setDialog,
}: {
  dialog: WorkbenchDialog
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
}) {
  const requestLogin = () => setDialog('account')
  return (
    <>
      <UtilityDialog
        description="로컬 LLM과 대화합니다."
        dialog={dialog}
        id="ai-chat"
        title="AI Chat"
        setDialog={setDialog}
      >
        <AiChatWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        description="연결된 Launcher와 worker 상태를 관리합니다."
        dialog={dialog}
        id="launchers"
        title="Launchers"
        setDialog={setDialog}
      >
        <LaunchersWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        description="CAE 및 AI Job 실행 이력을 확인합니다."
        dialog={dialog}
        id="jobs"
        title="Jobs"
        setDialog={setDialog}
      >
        <JobsWorkspace onRequestLogin={requestLogin} />
      </UtilityDialog>
      <UtilityDialog
        description="계정과 Access Token을 관리합니다."
        dialog={dialog}
        id="account"
        title="Account"
        setDialog={setDialog}
      >
        <AccountWorkspace />
      </UtilityDialog>
      <UtilityDialog
        description="Caemble 사용법과 CAD reference를 확인합니다."
        dialog={dialog}
        id="manual"
        title="Manual"
        setDialog={setDialog}
      >
        <ManualWorkspace onOpenWorkbench={() => setDialog(null)} />
      </UtilityDialog>
      <UtilityDialog
        description="Code-to-CAD 문법을 조회합니다."
        dialog={dialog}
        id="geometry-catalog"
        title="Geometry Catalog"
        setDialog={setDialog}
      >
        <GeometryCatalog />
      </UtilityDialog>
      <UtilityDialog
        description="표준 Material parameter 계약을 조회합니다."
        dialog={dialog}
        id="material-catalog"
        title="Material Catalog"
        setDialog={setDialog}
      >
        <MaterialCatalog />
      </UtilityDialog>
      <UtilityDialog
        description="표준 물리량과 UCUM 단위를 조회합니다."
        dialog={dialog}
        id="quantity-catalog"
        title="Quantity Catalog"
        setDialog={setDialog}
      >
        <QuantityCatalog />
      </UtilityDialog>
      <UtilityDialog
        description="Solver와 simulation API를 조회합니다."
        dialog={dialog}
        id="physics-catalog"
        title="Physics Catalog"
        setDialog={setDialog}
      >
        <PhysicsCatalog />
      </UtilityDialog>
    </>
  )
}

function UtilityDialog({
  children,
  description,
  dialog,
  id,
  setDialog,
  title,
}: {
  children: ReactNode
  description: string
  dialog: WorkbenchDialog
  id: Exclude<WorkbenchDialog, null>
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
  title: string
}) {
  const open = dialog === id
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && setDialog(null)}>
      <DialogContent className="grid h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden p-0 sm:max-w-[calc(100%-2rem)]">
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
