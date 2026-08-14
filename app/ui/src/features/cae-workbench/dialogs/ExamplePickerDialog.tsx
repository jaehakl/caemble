import { FlaskConical } from 'lucide-react'
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
import { blankExperimentSourceBundle } from '@/lib/localExperimentCode'

type ExperimentTemplate = Pick<
  CaembleProgramExample,
  'concepts' | 'description' | 'experimentSourceBundle' | 'id' | 'title'
>

const experimentTemplates: readonly ExperimentTemplate[] = Object.freeze([
  Object.freeze({
    id: 'blank-experiment',
    title: 'Blank Experiment',
    description: '필수 import와 실행 가능한 최소 골격만 있는 빈 Experiment로 돌아갑니다.',
    concepts: Object.freeze(['experiment.tsx', 'geometry.tsx', 'simulate.py', 'tasks/main.tsx']),
    experimentSourceBundle: blankExperimentSourceBundle,
  }),
  ...caembleProgramExamples,
])

export function ExamplePickerDialog({
  onOpenChange,
  onSelect,
  open,
}: {
  onOpenChange: (open: boolean) => void
  onSelect: (example: ExperimentTemplate) => void
  open: boolean
}) {
  const Icon = FlaskConical
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85dvh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>New Experiment</DialogTitle>
          <DialogDescription>검증된 예제에서 완전한 Experiment source를 시작합니다.</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 overflow-y-auto sm:grid-cols-2">
          {experimentTemplates.map((example) => (
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
