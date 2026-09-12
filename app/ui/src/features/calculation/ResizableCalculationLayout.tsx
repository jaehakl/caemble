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
import { ResizeHandle } from '@/shared/layout/ResizeHandle'
import { cn } from '@/lib/utils'
import { workbenchLayoutLimits } from '@/features/cae-workbench/types'

const handleSizePx = 8
const columnMinimumPx = 190
const rowMinimumPx = 96

type DragState = Readonly<{
  index: number
  orientation: 'horizontal' | 'vertical'
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

export function ResizableCalculationLayout({
  calculationList,
  columnRatios,
  editor,
  measurementExplorer,
  onColumnRatiosChange,
  onRowRatiosChange,
  output,
  recordedDataSummary,
  rowRatios,
  viewer,
  viewerExpanded = false,
  className,
}: {
  calculationList: ReactNode
  columnRatios: readonly number[]
  editor: ReactNode
  measurementExplorer: ReactNode
  onColumnRatiosChange: (ratios: readonly number[]) => void
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
  }, [columnPixels, drag, onColumnRatiosChange, onRowRatiosChange, rowPixels, size.height])

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

  return (
    <div
      className={cn('grid min-h-0 flex-1 overflow-hidden bg-background', className)}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: `${columnPixels[0]}px ${handleSizePx}px ${columnPixels[1]}px ${handleSizePx}px ${columnPixels[2]}px ${handleSizePx}px minmax(${columnMinimumPx}px, ${columnPixels[3]}px)`,
          minHeight: workbenchLayoutLimits.viewerMinHeightPx,
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
          label="1번째 행 경계 조절"
          orientation="horizontal"
          onKeyDown={(event) => resizeWithKeyboard(event, 'horizontal', 0)}
          onPointerDown={(event) => startDragging(event, 'horizontal', 0)}
        />
        <div className="min-h-0 overflow-hidden">{recordedDataSummary}</div>
        <ResizeHandle
          label="2번째 행 경계 조절"
          orientation="horizontal"
          onKeyDown={(event) => resizeWithKeyboard(event, 'horizontal', 1)}
          onPointerDown={(event) => startDragging(event, 'horizontal', 1)}
        />
        <div className="min-h-0 overflow-hidden">{calculationList}</div>
      </section>
      {viewerExpanded ? null : (
        <ResizeHandle
          label="1번째 열 경계 조절"
          orientation="vertical"
          onKeyDown={(event) => resizeWithKeyboard(event, 'vertical', 0)}
          onPointerDown={(event) => startDragging(event, 'vertical', 0)}
        />
      )}
      <section
        aria-label="3D Viewer"
        className="min-h-0 min-w-0 overflow-hidden"
        style={{
          gridColumn: viewerExpanded ? '1 / 4' : undefined,
        }}
      >
        {viewer}
      </section>
      <ResizeHandle
        label="2번째 열 경계 조절"
        orientation="vertical"
        onKeyDown={(event) => resizeWithKeyboard(event, 'vertical', 1)}
        onPointerDown={(event) => startDragging(event, 'vertical', 1)}
      />
      <section aria-label="Calculation Source Editor" className="min-h-0 min-w-0 overflow-hidden">
        {editor}
      </section>
      <ResizeHandle
        label="3번째 열 경계 조절"
        orientation="vertical"
        onKeyDown={(event) => resizeWithKeyboard(event, 'vertical', 2)}
        onPointerDown={(event) => startDragging(event, 'vertical', 2)}
      />
      <section aria-label="Calculation Output Chart" className="min-h-0 min-w-0 overflow-hidden">
        {output}
      </section>
    </div>
  )
}
