import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { geometryUsageCode } from './geometryUsage'

export function GeometryUsageDialog({
  alias,
  onOpenChange,
  onOpenExperimentSource,
  open,
}: {
  alias: string
  onOpenChange: (open: boolean) => void
  onOpenExperimentSource: () => void
  open: boolean
}) {
  const snippet = geometryUsageCode(alias)
  const copy = (value: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.success('코드를 복사했습니다.'))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Experiment에서 Geometry 사용</DialogTitle>
          <DialogDescription>
            Root alias <code>{alias}</code>는 Experiment와 Task에서 바로 사용하는 Geometry component 이름이며 JSX의{' '}
            <code>id</code>와는 별개입니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <section className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold">JSX usage</h3>
              <Button onClick={() => copy(snippet)} size="sm" type="button" variant="ghost">
                복사
              </Button>
            </div>
            <pre className="overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
              <code>{snippet}</code>
            </pre>
          </section>
          <p className="text-xs text-muted-foreground">
            필수 props와 타입은 연결된 exact Geometry source에서 가져오며 Monaco 자동완성과 진단으로 확인할 수 있습니다.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={() => copy(snippet)} type="button" variant="outline">
            JSX 복사
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onOpenExperimentSource()
            }}
            type="button"
          >
            experiment.tsx 열기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
