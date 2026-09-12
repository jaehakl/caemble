import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { SavedExperimentRecord, UserData } from '@/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { privateQueryScope } from '@/features/auth/queryKeys'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { availableExperimentsQueryOptions } from './queryOptions'
import { ExperimentShowcase } from './ExperimentShowcase'
import { ExperimentPreview } from './ExperimentPreview'

export function LoadExperimentDialog({
  user,
  current,
  onClose,
  onApply,
}: {
  user: UserData | null
  current: SavedExperimentRecord | null
  onClose: () => void
  onApply: (row: SavedExperimentRecord) => void
}) {
  const preview = useCaeWorkbenchState(user, Boolean(user?.is_active))
  const available = useQuery(availableExperimentsQueryOptions(privateQueryScope(user)))
  const initialized = useRef(false)
  const { loadExperiment } = preview
  useEffect(() => {
    if (initialized.current || !available.isSuccess) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || initialized.current) return
      initialized.current = true
      const row = current ?? available.data.demos.find((item) => item.demoDefault)
      if (row) void loadExperiment(row).catch((error: unknown) => toast.error(String(error)))
    })
    return () => {
      cancelled = true
    }
  }, [available.data, available.isSuccess, current, loadExperiment])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex h-[90dvh] w-[95vw] flex-col sm:max-w-[1400px]">
        <DialogHeader>
          <DialogTitle>Load Experiment</DialogTitle>
          <DialogDescription>미리 확인한 후 불러오기를 누르면 현재 작업에 적용됩니다.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto lg:grid-cols-2 lg:overflow-hidden">
          <div className="min-h-[320px] lg:min-h-0">
            <ExperimentShowcase
              mode="load"
              user={user}
              selectedId={preview.experimentId}
              onSelect={(row) => {
                initialized.current = true
                void loadExperiment(row).catch((error: unknown) => toast.error(String(error)))
              }}
            />
          </div>
          <div className="h-[55dvh] min-h-[320px] lg:h-auto lg:min-h-0">
            <ExperimentPreview workbench={preview} />
          </div>
        </div>
        <footer className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={!preview.experimentRecord || preview.selectionRestoring}
            onClick={() => {
              if (preview.experimentRecord) onApply(preview.experimentRecord)
            }}
          >
            불러오기
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
