import { useEffect, useRef, type ReactNode } from 'react'
import { ResizableWorkbenchSplit } from './ResizableWorkbenchSplit'
import { ResizeHandle } from '@/shared/layout/ResizeHandle'

export function ExperimentWorkspace({
  menubar,
  ribbon,
  viewer,
  editor,
  bottom,
  expanded,
  bottomVisible,
  bottomRatio,
  onBottomRatioChange,
}: {
  menubar: ReactNode
  ribbon: ReactNode
  viewer: ReactNode
  editor: ReactNode
  bottom: ReactNode
  expanded: boolean
  bottomVisible: boolean
  bottomRatio: number
  onBottomRatioChange: (ratio: number) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const stop = useRef<(() => void) | null>(null)
  useEffect(() => () => stop.current?.(), [])
  return (
    <div className="flex h-full min-h-0 flex-col">
      {menubar}
      {ribbon}
      <div ref={container} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <ResizableWorkbenchSplit viewer={viewer} editor={editor} viewerExpanded={expanded} />
        </div>
        {bottomVisible && !expanded ? (
          <div className="h-1 shrink-0 [&>div]:h-full">
            <ResizeHandle
              label="Console 높이 조절"
              orientation="horizontal"
              value={bottomRatio * 100}
              minimum={10}
              maximum={65}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault()
                  onBottomRatioChange(
                    Math.max(0.1, Math.min(0.65, bottomRatio + (event.key === 'ArrowUp' ? 0.02 : -0.02))),
                  )
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.preventDefault()
                stop.current?.()
                const move = (next: PointerEvent) => {
                  const bounds = container.current?.getBoundingClientRect()
                  if (bounds)
                    onBottomRatioChange(Math.max(0.1, Math.min(0.65, (bounds.bottom - next.clientY) / bounds.height)))
                }
                const end = () => {
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', end)
                  window.removeEventListener('pointercancel', end)
                  stop.current = null
                }
                stop.current = end
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', end)
                window.addEventListener('pointercancel', end)
              }}
            />
          </div>
        ) : null}
        {!expanded ? (
          <div
            className="shrink-0 overflow-hidden"
            style={{ height: bottomVisible ? `${Math.max(0.1, Math.min(0.65, bottomRatio)) * 100}%` : 32 }}
          >
            {bottom}
          </div>
        ) : null}
      </div>
    </div>
  )
}
