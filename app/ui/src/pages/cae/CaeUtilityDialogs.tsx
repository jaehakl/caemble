import { lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { WorkbenchDialog } from './caePageTypes'

const AccountWorkspace = lazy(() =>
  import('@/pages/account/AccountPage').then((module) => ({ default: module.AccountWorkspace })),
)

export function CaeUtilityDialogs({
  dialog,
  setDialog,
}: {
  dialog: WorkbenchDialog
  setDialog: Dispatch<SetStateAction<WorkbenchDialog>>
}) {
  return (
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
