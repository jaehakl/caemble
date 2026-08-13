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

export function GeometryUsageDialog({
  onOpenChange,
  onOpenGeometrySource,
  open,
  snippet,
}: {
  onOpenChange: (open: boolean) => void
  onOpenGeometrySource?: () => void
  open: boolean
  snippet: string
}) {
  const copy = () => {
    void navigator.clipboard
      .writeText(snippet)
      .then(() => toast.success('Geometry import 코드를 복사했습니다.'))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Experiment에서 Geometry 사용</DialogTitle>
          <DialogDescription>
            아래 exact import를 geometry.tsx에 붙여 넣고 named export를 조합하세요. experiment.tsx와 Task는
            geometry.tsx에서 상대 import합니다.
          </DialogDescription>
        </DialogHeader>
        <pre className="overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
          <code>{snippet}</code>
        </pre>
        <DialogFooter>
          <Button onClick={copy} type="button" variant="outline">
            코드 복사
          </Button>
          {onOpenGeometrySource ? (
            <Button
              onClick={() => {
                onOpenChange(false)
                onOpenGeometrySource()
              }}
              type="button"
            >
              geometry.tsx 열기
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
