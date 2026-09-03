import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MeasurementExplorer } from '@/features/measurement/MeasurementExplorer'
import type { SavedMeasurement } from '../types'

export function MeasurementPickerDialog({
  experimentId,
  onOpenChange,
  onSelect,
  open,
  selectedId,
}: {
  experimentId: number | null
  onOpenChange: (open: boolean) => void
  onSelect: (row: SavedMeasurement) => void
  open: boolean
  selectedId?: number | null
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Measurement 선택</DialogTitle>
          <DialogDescription className="sr-only">Measurement 선택</DialogDescription>
        </DialogHeader>
        <MeasurementExplorer
          className="min-h-64"
          enabled={open}
          experimentId={experimentId}
          onSelect={(row) => {
            onSelect(row)
            onOpenChange(false)
          }}
          selectedId={selectedId}
        />
      </DialogContent>
    </Dialog>
  )
}
