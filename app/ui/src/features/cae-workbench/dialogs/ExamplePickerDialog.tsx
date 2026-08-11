import { Box, FlaskConical, Microscope } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { caembleProgramExamples, type CaembleProgramExample } from '@/lib/examples'

export function ExamplePickerDialog({
  kind,
  onOpenChange,
  onSelect,
  open,
}: {
  kind: 'research' | 'structure' | 'experiment'
  onOpenChange: (open: boolean) => void
  onSelect: (example: CaembleProgramExample) => void
  open: boolean
}) {
  const label = kind === 'research' ? 'Research' : kind === 'structure' ? 'Structure' : 'Experiment'
  const Icon = kind === 'research' ? Microscope : kind === 'structure' ? Box : FlaskConical
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] max-w-4xl overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New {label}</DialogTitle>
          <DialogDescription>
            검증된 예제에서 {kind === 'research' ? 'Structure + Experiment pair' : label} source를 시작합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 overflow-y-auto sm:grid-cols-2">
          {caembleProgramExamples.map((example) => (
            <button
              className="group rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              key={example.id}
              type="button"
              onClick={() => {
                onSelect(example)
                onOpenChange(false)
              }}
            >
              <span className="flex items-center gap-2 font-semibold">
                <Icon className="size-4 text-primary" /> {example.title}
              </span>
              <span className="mt-2 line-clamp-3 block text-sm text-muted-foreground">{example.description}</span>
              <span className="mt-3 flex flex-wrap gap-1">
                {example.concepts.slice(0, 4).map((concept) => (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" key={concept}>
                    {concept}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
