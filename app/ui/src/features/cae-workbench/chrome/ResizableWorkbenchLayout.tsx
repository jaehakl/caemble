import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'
import { defaultWorkbenchLayoutState, workbenchLayoutLimits, type BottomDockMode } from '../types'

type DragState = Readonly<{
  pane: 'left' | 'right' | 'bottom'
  startClient: number
  startValue: number
}>

const clamp = (value: number, minimum: number, maximum: number) => Math.min(Math.max(value, minimum), maximum)

function ResizeHandle({
  label,
  orientation,
  value,
  minimum,
  maximum,
  onKeyDown,
  onPointerDown,
}: {
  label: string
  orientation: 'horizontal' | 'vertical'
  value: number
  minimum: number
  maximum: number
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemax={Math.round(maximum)}
      aria-valuemin={Math.round(minimum)}
      aria-valuenow={Math.round(value)}
      className={cn(
        'group relative z-10 bg-border/60 transition-colors outline-none hover:bg-primary/35 focus-visible:bg-primary/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute rounded-full bg-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          orientation === 'vertical'
            ? 'inset-y-2 left-1/2 w-0.5 -translate-x-1/2'
            : 'inset-x-2 top-1/2 h-0.5 -translate-y-1/2',
        )}
      />
    </div>
  )
}

export function ResizableWorkbenchLayout({
  left,
  viewer,
  right,
  bottom,
  bottomMode,
  leftWidthPx = defaultWorkbenchLayoutState.leftWidthPx,
  rightWidthPx = defaultWorkbenchLayoutState.rightWidthPx,
  bottomHeightPx = defaultWorkbenchLayoutState.bottomHeightPx,
  onLeftWidthChange,
  onRightWidthChange,
  onBottomHeightChange,
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
  leftWidthPx?: number
  rightWidthPx?: number
  bottomHeightPx?: number
  onLeftWidthChange?: (widthPx: number) => void
  onRightWidthChange?: (widthPx: number) => void
  onBottomHeightChange?: (heightPx: number) => void
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
    Math.min(
      workbenchLayoutLimits.leftMaxWidthPx,
      containerSize.width - sideSpace - workbenchLayoutLimits.rightMinWidthPx,
    ),
  )
  const effectiveLeftWidth = clamp(leftWidthPx, workbenchLayoutLimits.leftMinWidthPx, leftMaximum)
  const rightMaximum = Math.max(
    workbenchLayoutLimits.rightMinWidthPx,
    Math.min(workbenchLayoutLimits.rightMaxWidthPx, containerSize.width - sideSpace - effectiveLeftWidth),
  )
  const effectiveRightWidth = clamp(rightWidthPx, workbenchLayoutLimits.rightMinWidthPx, rightMaximum)
  const bottomMaximum = Math.max(
    workbenchLayoutLimits.bottomMinHeightPx,
    Math.min(
      workbenchLayoutLimits.bottomMaxHeightPx,
      containerSize.height - workbenchLayoutLimits.resizeHandlePx - workbenchLayoutLimits.viewerMinHeightPx,
    ),
  )
  const effectiveBottomHeight = clamp(bottomHeightPx, workbenchLayoutLimits.bottomMinHeightPx, bottomMaximum)

  useEffect(() => {
    if (!drag) return
    const handlePointerMove = (event: PointerEvent) => {
      if (drag.pane === 'left') {
        onLeftWidthChange?.(
          clamp(drag.startValue + event.clientX - drag.startClient, workbenchLayoutLimits.leftMinWidthPx, leftMaximum),
        )
      }
      if (drag.pane === 'right') {
        onRightWidthChange?.(
          clamp(
            drag.startValue - event.clientX + drag.startClient,
            workbenchLayoutLimits.rightMinWidthPx,
            rightMaximum,
          ),
        )
      }
      if (drag.pane === 'bottom') {
        onBottomHeightChange?.(
          clamp(
            drag.startValue - event.clientY + drag.startClient,
            workbenchLayoutLimits.bottomMinHeightPx,
            bottomMaximum,
          ),
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
  }, [bottomMaximum, drag, leftMaximum, onBottomHeightChange, onLeftWidthChange, onRightWidthChange, rightMaximum])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, pane: DragState['pane']) => {
    const step = event.shiftKey ? 64 : 16
    let next: number | null = null
    if (pane === 'left') {
      if (event.key === 'ArrowLeft') next = effectiveLeftWidth - step
      if (event.key === 'ArrowRight') next = effectiveLeftWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.leftMinWidthPx
      if (event.key === 'End') next = leftMaximum
      if (next !== null) onLeftWidthChange?.(clamp(next, workbenchLayoutLimits.leftMinWidthPx, leftMaximum))
    }
    if (pane === 'right') {
      if (event.key === 'ArrowRight') next = effectiveRightWidth - step
      if (event.key === 'ArrowLeft') next = effectiveRightWidth + step
      if (event.key === 'Home') next = workbenchLayoutLimits.rightMinWidthPx
      if (event.key === 'End') next = rightMaximum
      if (next !== null) onRightWidthChange?.(clamp(next, workbenchLayoutLimits.rightMinWidthPx, rightMaximum))
    }
    if (pane === 'bottom') {
      if (event.key === 'ArrowDown') next = effectiveBottomHeight - step
      if (event.key === 'ArrowUp') next = effectiveBottomHeight + step
      if (event.key === 'Home') next = workbenchLayoutLimits.bottomMinHeightPx
      if (event.key === 'End') next = bottomMaximum
      if (next !== null) onBottomHeightChange?.(clamp(next, workbenchLayoutLimits.bottomMinHeightPx, bottomMaximum))
    }
    if (next !== null) event.preventDefault()
  }

  const columns = `${effectiveLeftWidth}px ${workbenchLayoutLimits.resizeHandlePx}px minmax(${workbenchLayoutLimits.viewerMinWidthPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveRightWidth}px`
  const centerRows =
    bottomMode === 'hidden'
      ? `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${workbenchLayoutLimits.bottomCollapsedHeightPx}px`
      : `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${workbenchLayoutLimits.resizeHandlePx}px ${effectiveBottomHeight}px`
  const minimumHeight =
    workbenchLayoutLimits.viewerMinHeightPx +
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
          setDrag({ pane: 'left', startClient: event.clientX, startValue: effectiveLeftWidth })
        }}
        orientation="vertical"
        value={effectiveLeftWidth}
      />
      <div className="grid min-h-0 min-w-0 overflow-hidden" style={{ gridTemplateRows: centerRows }}>
        <section aria-label={viewerLabel} className="min-h-0 min-w-0 overflow-hidden">
          {viewer}
        </section>
        {bottomMode === 'hidden' ? null : (
          <ResizeHandle
            label="3D CAD View와 하단 도크 높이 조절"
            maximum={bottomMaximum}
            minimum={workbenchLayoutLimits.bottomMinHeightPx}
            onKeyDown={(event) => resizeWithKeyboard(event, 'bottom')}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              setDrag({ pane: 'bottom', startClient: event.clientY, startValue: effectiveBottomHeight })
            }}
            orientation="horizontal"
            value={effectiveBottomHeight}
          />
        )}
        <div className="min-h-0 min-w-0 overflow-hidden">{bottom}</div>
      </div>
      <ResizeHandle
        label="오른쪽 Detail 너비 조절"
        maximum={rightMaximum}
        minimum={workbenchLayoutLimits.rightMinWidthPx}
        onKeyDown={(event) => resizeWithKeyboard(event, 'right')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          setDrag({ pane: 'right', startClient: event.clientX, startValue: effectiveRightWidth })
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
