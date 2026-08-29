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
import { workbenchLayoutLimits, type BottomDockMode } from '../types'

const handleSizePx = 8
const columnMinimumPx = 190
const rowMinimumPx = 96

type DragState = Readonly<{
  index: number
  orientation: 'bottom' | 'horizontal' | 'vertical'
  startClient: number
  startBeforePx: number
  startAfterPx: number
}>

function normalizedRatios(values: readonly number[], fallback: readonly number[]) {
  if (values.length !== fallback.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return [...fallback]
  }
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => value / total)
}

function ResizeHandle({
  index,
  label,
  orientation,
  onKeyDown,
  onPointerDown,
}: {
  index: number
  label?: string
  orientation: 'horizontal' | 'vertical'
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, index: number) => void
}) {
  return (
    <div
      aria-label={
        label ?? (orientation === 'vertical' ? `${index + 1}번째 열 경계 조절` : `${index + 1}번째 행 경계 조절`)
      }
      aria-orientation={orientation}
      className={cn(
        'group relative z-10 bg-border/60 transition-colors outline-none hover:bg-primary/35 focus-visible:bg-primary/45 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        orientation === 'vertical' ? 'cursor-col-resize' : 'cursor-row-resize',
      )}
      onKeyDown={(event) => onKeyDown(event, index)}
      onPointerDown={(event) => onPointerDown(event, index)}
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

export function ResizableCalculationLayout({
  bottom,
  bottomHeightRatio,
  bottomMode,
  calculationList,
  columnRatios,
  editor,
  measurementExplorer,
  onColumnRatiosChange,
  onBottomHeightRatioChange,
  onRowRatiosChange,
  output,
  recordedDataSummary,
  rowRatios,
  viewer,
  viewerExpanded = false,
  className,
}: {
  bottom: ReactNode
  bottomHeightRatio: number
  bottomMode: BottomDockMode
  calculationList: ReactNode
  columnRatios: readonly number[]
  editor: ReactNode
  measurementExplorer: ReactNode
  onColumnRatiosChange: (ratios: readonly number[]) => void
  onBottomHeightRatioChange: (ratio: number) => void
  onRowRatiosChange: (ratios: readonly number[]) => void
  output: ReactNode
  recordedDataSummary: ReactNode
  rowRatios: readonly number[]
  viewer: ReactNode
  viewerExpanded?: boolean
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1280, height: 600 })
  const [drag, setDrag] = useState<DragState | null>(null)
  const columns = normalizedRatios(columnRatios, [0.22, 0.26, 0.26, 0.26])
  const rows = normalizedRatios(rowRatios, [0.45, 0.25, 0.3])
  const availableWidth = Math.max(1, size.width - handleSizePx * 3)
  const availableHeight = Math.max(1, size.height - handleSizePx * 2)
  const columnPixels = columns.map((ratio) => ratio * availableWidth)
  const rowPixels = rows.map((ratio) => ratio * availableHeight)
  const bottomMaximum = Math.max(
    workbenchLayoutLimits.bottomMinHeightPx,
    size.height - workbenchLayoutLimits.resizeHandlePx - workbenchLayoutLimits.viewerMinHeightPx,
  )
  const bottomHeight = Math.min(
    bottomMaximum,
    Math.max(workbenchLayoutLimits.bottomMinHeightPx, bottomHeightRatio * size.height),
  )

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (width: number, height: number) => {
      if (width > 0 && height > 0) setSize({ width, height })
    }
    const bounds = container.getBoundingClientRect()
    update(bounds.width, bounds.height)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!drag) return
    const move = (event: PointerEvent) => {
      if (drag.orientation === 'bottom') {
        onBottomHeightRatioChange(
          Math.min(
            bottomMaximum,
            Math.max(workbenchLayoutLimits.bottomMinHeightPx, drag.startAfterPx - event.clientY + drag.startClient),
          ) / size.height,
        )
        return
      }
      const currentClient = drag.orientation === 'vertical' ? event.clientX : event.clientY
      const delta = currentClient - drag.startClient
      const pairTotal = drag.startBeforePx + drag.startAfterPx
      const minimum = drag.orientation === 'vertical' ? columnMinimumPx : rowMinimumPx
      const before = Math.min(pairTotal - minimum, Math.max(minimum, drag.startBeforePx + delta))
      const source = drag.orientation === 'vertical' ? columnPixels : rowPixels
      const next = [...source]
      next[drag.index] = before
      next[drag.index + 1] = pairTotal - before
      const total = next.reduce((sum, value) => sum + value, 0)
      if (drag.orientation === 'vertical') onColumnRatiosChange(next.map((value) => value / total))
      else onRowRatiosChange(next.map((value) => value / total))
    }
    const stop = () => setDrag(null)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = drag.orientation === 'vertical' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
    }
  }, [
    bottomMaximum,
    columnPixels,
    drag,
    onBottomHeightRatioChange,
    onColumnRatiosChange,
    onRowRatiosChange,
    rowPixels,
    size.height,
  ])

  const resizeWithKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    orientation: 'horizontal' | 'vertical',
    index: number,
  ) => {
    const negative = orientation === 'vertical' ? event.key === 'ArrowLeft' : event.key === 'ArrowUp'
    const positive = orientation === 'vertical' ? event.key === 'ArrowRight' : event.key === 'ArrowDown'
    if (!negative && !positive && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const source = orientation === 'vertical' ? columnPixels : rowPixels
    const minimum = orientation === 'vertical' ? columnMinimumPx : rowMinimumPx
    const pairTotal = source[index] + source[index + 1]
    const step = event.shiftKey ? 64 : 16
    const before =
      event.key === 'Home'
        ? minimum
        : event.key === 'End'
          ? pairTotal - minimum
          : Math.min(pairTotal - minimum, Math.max(minimum, source[index] + (negative ? -step : step)))
    const next = [...source]
    next[index] = before
    next[index + 1] = pairTotal - before
    const total = next.reduce((sum, value) => sum + value, 0)
    if (orientation === 'vertical') onColumnRatiosChange(next.map((value) => value / total))
    else onRowRatiosChange(next.map((value) => value / total))
  }

  const startDragging = (
    event: ReactPointerEvent<HTMLDivElement>,
    orientation: 'horizontal' | 'vertical',
    index: number,
  ) => {
    if (event.button !== 0) return
    event.preventDefault()
    const source = orientation === 'vertical' ? columnPixels : rowPixels
    setDrag({
      index,
      orientation,
      startAfterPx: source[index + 1],
      startBeforePx: source[index],
      startClient: orientation === 'vertical' ? event.clientX : event.clientY,
    })
  }

  const resizeBottomWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16
    let next: number | null = null
    if (event.key === 'ArrowDown') next = bottomHeight - step
    if (event.key === 'ArrowUp') next = bottomHeight + step
    if (event.key === 'Home') next = workbenchLayoutLimits.bottomMinHeightPx
    if (event.key === 'End') next = bottomMaximum
    if (next === null) return
    event.preventDefault()
    onBottomHeightRatioChange(
      Math.min(bottomMaximum, Math.max(workbenchLayoutLimits.bottomMinHeightPx, next)) / size.height,
    )
  }

  const viewerRows =
    bottomMode === 'hidden'
      ? `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${workbenchLayoutLimits.bottomCollapsedHeightPx}px`
      : `minmax(${workbenchLayoutLimits.viewerMinHeightPx}px, 1fr) ${handleSizePx}px ${bottomHeight}px`

  return (
    <div
      className={cn('grid min-h-0 flex-1 overflow-hidden bg-background', className)}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: `${columnPixels[0]}px ${handleSizePx}px ${columnPixels[1]}px ${handleSizePx}px ${columnPixels[2]}px ${handleSizePx}px minmax(${columnMinimumPx}px, ${columnPixels[3]}px)`,
          minHeight: viewerExpanded
            ? workbenchLayoutLimits.viewerMinHeightPx
            : bottomMode === 'hidden'
              ? workbenchLayoutLimits.viewerMinHeightPx + workbenchLayoutLimits.bottomCollapsedHeightPx
              : workbenchLayoutLimits.viewerMinHeightPx + handleSizePx + workbenchLayoutLimits.bottomMinHeightPx,
        } satisfies CSSProperties
      }
    >
      <section
        aria-label="Measurement, ExperimentRecord와 RecordedData, Calculation 목록"
        className={cn('grid min-h-0 min-w-0 overflow-hidden', viewerExpanded && 'hidden')}
        hidden={viewerExpanded}
        style={{
          gridTemplateRows: `${rowPixels[0]}px ${handleSizePx}px ${rowPixels[1]}px ${handleSizePx}px minmax(${rowMinimumPx}px, ${rowPixels[2]}px)`,
        }}
      >
        <div className="min-h-0 overflow-hidden">{measurementExplorer}</div>
        <ResizeHandle
          index={0}
          orientation="horizontal"
          onKeyDown={(event, index) => resizeWithKeyboard(event, 'horizontal', index)}
          onPointerDown={(event, index) => startDragging(event, 'horizontal', index)}
        />
        <div className="min-h-0 overflow-hidden">{recordedDataSummary}</div>
        <ResizeHandle
          index={1}
          orientation="horizontal"
          onKeyDown={(event, index) => resizeWithKeyboard(event, 'horizontal', index)}
          onPointerDown={(event, index) => startDragging(event, 'horizontal', index)}
        />
        <div className="min-h-0 overflow-hidden">{calculationList}</div>
      </section>
      {viewerExpanded ? null : (
        <ResizeHandle
          index={0}
          orientation="vertical"
          onKeyDown={(event, index) => resizeWithKeyboard(event, 'vertical', index)}
          onPointerDown={(event, index) => startDragging(event, 'vertical', index)}
        />
      )}
      <section
        aria-label="3D Viewer와 하단 도크"
        className="grid min-h-0 min-w-0 overflow-hidden"
        style={{
          gridColumn: viewerExpanded ? '1 / 4' : undefined,
          gridTemplateRows: viewerExpanded ? 'minmax(0, 1fr)' : viewerRows,
        }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">{viewer}</div>
        {!viewerExpanded && bottomMode !== 'hidden' ? (
          <ResizeHandle
            index={0}
            label="3D Viewer와 하단 도크 높이 조절"
            orientation="horizontal"
            onKeyDown={(event) => resizeBottomWithKeyboard(event)}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              setDrag({
                index: 0,
                orientation: 'bottom',
                startAfterPx: bottomHeight,
                startBeforePx: size.height - handleSizePx - bottomHeight,
                startClient: event.clientY,
              })
            }}
          />
        ) : null}
        <div className="min-h-0 min-w-0 overflow-hidden" hidden={viewerExpanded}>
          {bottom}
        </div>
      </section>
      <ResizeHandle
        index={1}
        orientation="vertical"
        onKeyDown={(event, index) => resizeWithKeyboard(event, 'vertical', index)}
        onPointerDown={(event, index) => startDragging(event, 'vertical', index)}
      />
      <section aria-label="Calculation Source Editor" className="min-h-0 min-w-0 overflow-hidden">
        {editor}
      </section>
      <ResizeHandle
        index={2}
        orientation="vertical"
        onKeyDown={(event, index) => resizeWithKeyboard(event, 'vertical', index)}
        onPointerDown={(event, index) => startDragging(event, 'vertical', index)}
      />
      <section aria-label="Calculation Output Chart" className="min-h-0 min-w-0 overflow-hidden">
        {output}
      </section>
    </div>
  )
}
