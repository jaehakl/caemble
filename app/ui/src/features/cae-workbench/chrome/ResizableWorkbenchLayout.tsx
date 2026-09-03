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
import { defaultWorkbenchLayoutState, workbenchLayoutLimits, type BottomDockMode } from '../types'

type DragState = Readonly<{
  pane: 'left' | 'right' | 'bottom'
  startClient: number
  startValuePx: number
}>

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum)

export function ResizableWorkbenchLayout({
  left,
  viewer,
  right,
  bottom,
  bottomMode,
  leftWidthRatio = defaultWorkbenchLayoutState.leftWidthRatio,
  rightWidthRatio = defaultWorkbenchLayoutState.rightWidthRatio,
  bottomHeightRatio = defaultWorkbenchLayoutState.bottomHeightRatio,
  viewerExpanded = defaultWorkbenchLayoutState.viewerExpanded,
  onLeftWidthRatioChange,
  onRightWidthRatioChange,
  onBottomHeightRatioChange,
  leftLabel = '목록',
  viewerLabel = '3D CAD View',
  rightLabel = 'Detail',
  className,
}: {
  left: ReactNode
  viewer: ReactNode
  right: ReactNode
  bottom: ReactNode
  bottomMode: BottomDockMode
  leftWidthRatio?: number
  rightWidthRatio?: number
  bottomHeightRatio?: number
  viewerExpanded?: boolean
  onLeftWidthRatioChange?: (ratio: number) => void
  onRightWidthRatioChange?: (ratio: number) => void
  onBottomHeightRatioChange?: (ratio: number) => void
  leftLabel?: string
  viewerLabel?: string
  rightLabel?: string
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: workbenchLayoutLimits.appMinWidthPx,
    height: 640,
  })
  const [drag, setDrag] = useState<DragState | null>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateSize = (width: number, height: number) => {
      setContainerSize((current) => ({
        width: width > 0 ? width : current.width,
        height: height > 0 ? height : current.height,
      }))
    }
    const bounds = container.getBoundingClientRect()
    updateSize(bounds.width, bounds.height)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateSize(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const sideSpace = workbenchLayoutLimits.resizeHandlePx * 2 + workbenchLayoutLimits.viewerMinWidthPx
  const leftMaximum = Math.max(
    workbenchLayoutLimits.leftMinWidthPx,
    containerSize.width - sideSpace - workbenchLayoutLimits.rightMinWidthPx,
  )
  const effectiveLeftWidth = clamp(
    leftWidthRatio * containerSize.width,
    workbenchLayoutLimits.leftMinWidthPx,
    leftMaximum,
  )
  const rightMaximum = Math.max(
    workbenchLayoutLimits.rightMinWidthPx,
    containerSize.width - sideSpace - effectiveLeftWidth,
  )
  const effectiveRightWidth = clamp(
    rightWidthRatio * containerSize.width,
    workbenchLayoutLimits.rightMinWidthPx,
    rightMaximum,
  )
  const bottomMaximum = Math.max(
    workbenchLayoutLimits.bottomMinHeightPx,
    containerSize.height - workbenchLayoutLimits.resizeHandlePx - workbenchLayoutLimits.viewerMinHeightPx,
  )
  const effectiveBottomHeight = clamp(
    bottomHeightRatio * containerSize.height,
    workbenchLayoutLimits.bottomMinHeightPx,
    bottomMaximum,
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
          ) / containerSize.width,
        )
      }
      if (drag.pane === 'right') {
        onRightWidthRatioChange?.(
          clamp(
            drag.startValuePx - event.clientX + drag.startClient,
            workbenchLayoutLimits.rightMinWidthPx,
            rightMaximum,
          ) / containerSize.width,
        )
      }
      if (drag.pane === 'bottom') {
        onBottomHeightRatioChange?.(
          clamp(
            drag.startValuePx - event.clientY + drag.startClient,
            workbenchLayoutLimits.bottomMinHeightPx,
            bottomMaximum,
          ) / containerSize.height,
        )
      }
    }
    const stopDragging = () => setDrag(null)
    document.body.style.cursor = drag.pane === 'bottom' ? 'row-resize' : 'col-resize'
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
  }, [
    bottomMaximum,
    containerSize.height,
    containerSize.width,
    drag,
    leftMaximum,
    onBottomHeightRatioChange,
    onLeftWidthRatioChange,
    onRightWidthRatioChange,
    rightMaximum,
  ])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, pane: DragState['pane']) => {
    const step = event.shiftKey ? 64 : 16
    let next: number | null = null
    if (pane === 'left') {
      if (event.key === 'ArrowLeft') next = effectiveLeftWidth - step
      if (event.key === 'ArrowRight') next = effectiveLeftWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.leftMinWidthPx
      if (event.key === 'End') next = leftMaximum
      if (next !== null) {
        onLeftWidthRatioChange?.(clamp(next, workbenchLayoutLimits.leftMinWidthPx, leftMaximum) / containerSize.width)
      }
    }
    if (pane === 'right') {
      if (event.key === 'ArrowRight') next = effectiveRightWidth - step
      if (event.key === 'ArrowLeft') next = effectiveRightWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.rightMinWidthPx
      if (event.key === 'End') next = rightMaximum
      if (next !== null) {
        onRightWidthRatioChange?.(
          clamp(next, workbenchLayoutLimits.rightMinWidthPx, rightMaximum) / containerSize.width,
        )
      }
    }
    if (pane === 'bottom') {
      if (event.key === 'ArrowDown') next = effectiveBottomHeight - step
      if (event.key === 'ArrowUp') next = effectiveBottomHeight + step
      if (event.key === 'Home') next = workbenchLayoutLimits.bottomMinHeightPx
      if (event.key === 'End') next = bottomMaximum
      if (next !== null) {
        onBottomHeightRatioChange?.(
          clamp(next, workbenchLayoutLimits.bottomMinHeightPx, bottomMaximum) / containerSize.height,
        )
      }
    }
    if (next !== null) event.preventDefault()
  }

  const columns = viewerExpanded
    ? `minmax(${workbenchLayoutLimits.viewerMinWidthPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveRightWidth}px`
    : `${effectiveLeftWidth}px ${workbenchLayoutLimits.resizeHandlePx}px minmax(${workbenchLayoutLimits.viewerMinWidthPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveRightWidth}px`
  const centerRows = viewerExpanded
    ? `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr)`
    : bottomMode === 'hidden'
      ? `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${workbenchLayoutLimits.bottomCollapsedHeightPx}px`
      : `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveBottomHeight}px`
  const minimumHeight = viewerExpanded
    ? workbenchLayoutLimits.viewerMinHeightPx
    : workbenchLayoutLimits.viewerMinHeightPx +
      workbenchLayoutLimits.resizeHandlePx +
      workbenchLayoutLimits.bottomMinHeightPx

  return (
    <div
      className={cn('grid h-full min-h-0 flex-1 overflow-hidden bg-background', className)}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: columns,
          minHeight: minimumHeight,
          minWidth: workbenchLayoutLimits.appMinWidthPx,
        } satisfies CSSProperties
      }
    >
      <section aria-label={leftLabel} className="min-h-0 min-w-0 overflow-hidden" hidden={viewerExpanded}>
        {left}
      </section>
      {viewerExpanded ? null : (
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
      )}
      <div className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateRows: centerRows }}>
        <section aria-label={viewerLabel} className="min-h-0 min-w-0 overflow-hidden">
          {viewer}
        </section>
        {viewerExpanded || bottomMode === 'hidden' ? null : (
          <ResizeHandle
            label="3D CAD View와 하단 도크 높이 조절"
            maximum={bottomMaximum}
            minimum={workbenchLayoutLimits.bottomMinHeightPx}
            onKeyDown={(event) => resizeWithKeyboard(event, 'bottom')}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              setDrag({ pane: 'bottom', startClient: event.clientY, startValuePx: effectiveBottomHeight })
            }}
            orientation="horizontal"
            value={effectiveBottomHeight}
          />
        )}
        <div className="min-h-0 min-w-0 overflow-hidden" hidden={viewerExpanded}>
          {bottom}
        </div>
      </div>
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
