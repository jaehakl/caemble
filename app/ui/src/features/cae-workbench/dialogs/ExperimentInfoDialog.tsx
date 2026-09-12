import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { ExperimentDetail } from '@/features/cae-workbench/WorkbenchDetails'

export function ExperimentInfoDialog({ onClose, workbench }: { onClose: () => void; workbench: CaeWorkbenchState }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="grid max-h-[calc(100dvh-2rem)] w-[min(52rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left">
          <DialogTitle>Experiment Info</DialogTitle>
          <DialogDescription>현재 Experiment의 상태와 구성 정보를 확인합니다.</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          <ExperimentDetail variant="dialog" workbench={workbench} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
