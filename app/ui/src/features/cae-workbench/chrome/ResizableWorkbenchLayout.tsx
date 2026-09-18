import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { ResizeHandle } from '@/shared/layout/ResizeHandle'
import { cn } from '@/lib/utils'
import { defaultWorkbenchLayoutState, workbenchLayoutLimits } from '../types'

type DragState = Readonly<{
  pane: 'left' | 'right'
  startClient: number
  startValuePx: number
}>

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum)

export function ResizableWorkbenchLayout({
  left,
  viewer,
  right,
  leftWidthRatio = defaultWorkbenchLayoutState.leftWidthRatio,
  rightWidthRatio = defaultWorkbenchLayoutState.rightWidthRatio,
  onLeftWidthRatioChange,
  onRightWidthRatioChange,
  leftLabel = '목록',
  viewerLabel = '3D CAD View',
  rightLabel = 'Detail',
  className,
}: {
  left: ReactNode
  viewer: ReactNode
  right: ReactNode
  leftWidthRatio?: number
  rightWidthRatio?: number
  onLeftWidthRatioChange?: (ratio: number) => void
  onRightWidthRatioChange?: (ratio: number) => void
  leftLabel?: string
  viewerLabel?: string
  rightLabel?: string
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState<number>(workbenchLayoutLimits.appMinWidthPx)
  const [drag, setDrag] = useState<DragState | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateWidth = (width: number) => {
      if (width > 0) setContainerWidth(width)
    }
    const bounds = container.getBoundingClientRect()
    updateWidth(bounds.width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const sideSpace = workbenchLayoutLimits.resizeHandlePx * 2 + workbenchLayoutLimits.viewerMinWidthPx
  const leftMaximum = Math.max(
    workbenchLayoutLimits.leftMinWidthPx,
    containerWidth - sideSpace - workbenchLayoutLimits.rightMinWidthPx,
  )
  const effectiveLeftWidth = clamp(leftWidthRatio * containerWidth, workbenchLayoutLimits.leftMinWidthPx, leftMaximum)
  const rightMaximum = Math.max(workbenchLayoutLimits.rightMinWidthPx, containerWidth - sideSpace - effectiveLeftWidth)
  const effectiveRightWidth = clamp(
    rightWidthRatio * containerWidth,
    workbenchLayoutLimits.rightMinWidthPx,
    rightMaximum,
  )
  useEffect(() => {
    if (!drag) return
    const handlePointerMove = (event: PointerEvent) => {
      if (drag.pane === 'left') {
        onLeftWidthRatioChange?.(
          clamp(
            drag.startValuePx + event.clientX - drag.startClient,
            workbenchLayoutLimits.leftMinWidthPx,
            leftMaximum,
          ) / containerWidth,
        )
      }
      if (drag.pane === 'right') {
        onRightWidthRatioChange?.(
          clamp(
            drag.startValuePx - event.clientX + drag.startClient,
            workbenchLayoutLimits.rightMinWidthPx,
            rightMaximum,
          ) / containerWidth,
        )
      }
    }
    const stopDragging = () => setDrag(null)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopDragging)
    window.addEventListener('pointercancel', stopDragging)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopDragging)
      window.removeEventListener('pointercancel', stopDragging)
    }
  }, [containerWidth, drag, leftMaximum, onLeftWidthRatioChange, onRightWidthRatioChange, rightMaximum])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, pane: DragState['pane']) => {
    const step = event.shiftKey ? 64 : 16
    let next: number | null = null
    if (pane === 'left') {
      if (event.key === 'ArrowLeft') next = effectiveLeftWidth - step
      if (event.key === 'ArrowRight') next = effectiveLeftWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.leftMinWidthPx
      if (event.key === 'End') next = leftMaximum
      if (next !== null) {
        onLeftWidthRatioChange?.(clamp(next, workbenchLayoutLimits.leftMinWidthPx, leftMaximum) / containerWidth)
      }
    }
    if (pane === 'right') {
      if (event.key === 'ArrowRight') next = effectiveRightWidth - step
      if (event.key === 'ArrowLeft') next = effectiveRightWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.rightMinWidthPx
      if (event.key === 'End') next = rightMaximum
      if (next !== null) {
        onRightWidthRatioChange?.(clamp(next, workbenchLayoutLimits.rightMinWidthPx, rightMaximum) / containerWidth)
      }
    }
    if (next !== null) event.preventDefault()
  }

  const columns = `${effectiveLeftWidth}px ${workbenchLayoutLimits.resizeHandlePx}px minmax(${workbenchLayoutLimits.viewerMinWidthPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveRightWidth}px`
  return (
    <div
      className={cn('grid h-full min-h-0 flex-1 overflow-hidden bg-background', className)}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: columns,
          minHeight: workbenchLayoutLimits.viewerMinHeightPx,
          minWidth: workbenchLayoutLimits.appMinWidthPx,
        } satisfies CSSProperties
      }
    >
      <section aria-label={leftLabel} className="min-h-0 min-w-0 overflow-hidden">
        {left}
      </section>

      <ResizeHandle
        label="왼쪽 목록 너비 조절"
        maximum={leftMaximum}
        minimum={workbenchLayoutLimits.leftMinWidthPx}
        onKeyDown={(event) => resizeWithKeyboard(event, 'left')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          setDrag({ pane: 'left', startClient: event.clientX, startValuePx: effectiveLeftWidth })
        }}
        orientation="vertical"
        value={effectiveLeftWidth}
      />
      <section aria-label={viewerLabel} className="min-h-0 min-w-0 overflow-hidden">
        {viewer}
      </section>
      <ResizeHandle
        label="오른쪽 Detail 너비 조절"
        maximum={rightMaximum}
        minimum={workbenchLayoutLimits.rightMinWidthPx}
        onKeyDown={(event) => resizeWithKeyboard(event, 'right')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          setDrag({ pane: 'right', startClient: event.clientX, startValuePx: effectiveRightWidth })
        }}
        orientation="vertical"
        value={effectiveRightWidth}
      />
      <section aria-label={rightLabel} className="min-h-0 min-w-0 overflow-hidden">
        {right}
      </section>
    </div>
  )
}
