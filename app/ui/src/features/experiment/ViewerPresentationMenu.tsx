import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { Image } from 'lucide-react'
import { ViewerToolMenu } from '@/features/viewer/viewer/ViewerTools'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ExperimentPresentationUpdate, ViewerDefaults } from '@/contracts/viewerDefaults'
import {
  captureViewer,
  centeredThumbnailCrop,
  cropThumbnail,
  type ThumbnailCrop,
  type ViewerCapture,
} from '@/features/viewer/persistence/viewerThumbnail'
import { ThumbnailCropEditor } from '@/features/viewer/persistence/ThumbnailCropEditor'

export type ViewerPresentationActions = {
  experimentId: number
  measurementId: number | null
  hasInitialView: boolean
  canSaveInitialView: boolean
  update: (payload: ExperimentPresentationUpdate) => Promise<unknown>
}

export function ViewerPresentationMenu({
  actions,
  snapshot,
  captureNode,
  disabled = false,
}: {
  actions: ViewerPresentationActions
  snapshot: () => ViewerDefaults
  captureNode: () => HTMLDivElement | null
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [capture, setCapture] = useState<ViewerCapture | null>(null)
  const [crop, setCrop] = useState<ThumbnailCrop | null>(null)
  const [error, setError] = useState('')
  const run = async (operation: () => Promise<void>) => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast.error(message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <>
      <ViewerToolMenu label="초기 화면·대표이미지" icon={<Image />}>
        <div className="grid gap-1">
          <DropdownMenuItem asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || disabled || !actions.canSaveInitialView || !actions.measurementId}
              title={
                !actions.canSaveInitialView
                  ? '저장된 소스의 Recorded Measurement를 표시할 때 저장할 수 있습니다.'
                  : undefined
              }
              onClick={() =>
                void run(async () => {
                  await actions.update({ initialView: { ...snapshot(), measurementId: actions.measurementId! } })
                  toast.success('현재 화면을 Experiment 초기 화면으로 저장했습니다.')
                })
              }
            >
              현재 화면을 초기 화면으로 저장
            </Button>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !actions.hasInitialView}
              onClick={() =>
                void run(async () => {
                  await actions.update({ initialView: null })
                  toast.success('초기 화면 설정을 해제했습니다. 다음 진입부터 최신 결과를 표시합니다.')
                })
              }
            >
              초기 화면 설정 해제
            </Button>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || disabled}
              onClick={() =>
                void run(async () => {
                  const next = await captureViewer(captureNode())
                  setCapture(next)
                  setCrop(centeredThumbnailCrop(next.width, next.height))
                })
              }
            >
              대표이미지 변경
            </Button>
          </DropdownMenuItem>
        </div>
      </ViewerToolMenu>
      {capture && crop ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setCapture(null)
          }}
        >
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>대표이미지 변경</DialogTitle>
              <DialogDescription>
                현재 Viewer 캡처를 4:3으로 잘라 이 Experiment 버전의 대표이미지로 저장합니다.
              </DialogDescription>
            </DialogHeader>
            <ThumbnailCropEditor capture={capture} crop={crop} onChange={setCrop} disabled={busy} />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setCapture(null)}>
                취소
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const thumbnail = await cropThumbnail(capture, crop)
                    await actions.update({ thumbnail })
                    setCapture(null)
                    toast.success('대표이미지를 변경했습니다.')
                  })
                }
              >
                {busy ? '저장 중…' : '저장'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}
