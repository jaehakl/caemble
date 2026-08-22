import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MeasurementExplorer } from '../measurement/MeasurementExplorer'
import type { SavedMeasurement } from '../types'

export function MeasurementPickerDialog({
  experimentId,
  onDuplicate,
  onOpenChange,
  onSelect,
  open,
  selectedId,
}: {
  experimentId: number | null
  onDuplicate: (row: SavedMeasurement) => void
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
          <DialogDescription>현재 Experiment에 준비된 고정 입력 조건을 선택합니다.</DialogDescription>
        </DialogHeader>
        <MeasurementExplorer
          className="min-h-64"
          enabled={open}
          experimentId={experimentId}
          onDuplicate={onDuplicate}
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
