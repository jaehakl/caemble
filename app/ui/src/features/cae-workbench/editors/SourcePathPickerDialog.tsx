import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CadSourcePathLocation } from '@/features/viewer/editor/cadSelectionSource'

export function SourcePathPickerDialog({
  locations,
  onOpenChange,
  onSelect,
  open,
  value,
}: {
  locations: readonly CadSourcePathLocation[]
  onOpenChange: (open: boolean) => void
  onSelect: (location: CadSourcePathLocation) => void
  open: boolean
  value: string
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[70dvh] w-[min(28rem,calc(100%-2rem))] flex-col gap-3 overflow-hidden p-4 sm:max-w-md">
        <DialogHeader className="gap-1 pr-6">
          <DialogTitle className="text-sm">Source에서 경로 찾기</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs" title={value}>
            {value}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto rounded border">
          {locations.map((location) => (
            <button
              className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
              key={`${location.path}:${location.start}`}
              type="button"
              onClick={() => onSelect(location)}
            >
              <div className="font-mono text-[11px] font-medium text-foreground">
                {location.path}:{location.line}:{location.column}
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={location.preview}>
                {location.preview}
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
