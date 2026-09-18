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

type DragState = Readonly<{
  index: number
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
  columnRatios,
  editor,
  onColumnRatiosChange,
  output,
  viewer,
  className,
}: {
  columnRatios: readonly number[]
  editor: ReactNode
  onColumnRatiosChange: (ratios: readonly number[]) => void
  output: ReactNode
  viewer: ReactNode
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 1280, height: 600 })
  const [drag, setDrag] = useState<DragState | null>(null)
  const columns = normalizedRatios(columnRatios, [0.3, 0.4, 0.3])

  const availableWidth = Math.max(1, size.width - handleSizePx * 2)

  const columnPixels = columns.map((ratio) => ratio * availableWidth)

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
      const currentClient = event.clientX
      const delta = currentClient - drag.startClient
      const pairTotal = drag.startBeforePx + drag.startAfterPx
      const minimum = Math.min(columnMinimumPx, pairTotal / 2)
      const before = Math.min(pairTotal - minimum, Math.max(minimum, drag.startBeforePx + delta))
      const source = columnPixels
      const next = [...source]
      next[drag.index] = before
      next[drag.index + 1] = pairTotal - before
      const total = next.reduce((sum, value) => sum + value, 0)
      onColumnRatiosChange(next.map((value) => value / total))
    }
    const stop = () => setDrag(null)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
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
  }, [columnPixels, drag, onColumnRatiosChange, size.height])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, index: number) => {
    const negative = event.key === 'ArrowLeft'
    const positive = event.key === 'ArrowRight'
    if (!negative && !positive && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const source = columnPixels
    const pairTotal = source[index] + source[index + 1]
    const minimum = Math.min(columnMinimumPx, pairTotal / 2)
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
    onColumnRatiosChange(next.map((value) => value / total))
  }

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>, index: number) => {
    if (event.button !== 0) return
    event.preventDefault()
    const source = columnPixels
    setDrag({
      index,
      startAfterPx: source[index + 1],
      startBeforePx: source[index],
      startClient: event.clientX,
    })
  }

  return (
    <div
      className={cn('grid min-h-0 flex-1 overflow-hidden bg-background', className)}
      ref={containerRef}
      style={
        {
          gridTemplateColumns: `${columnPixels[0]}px ${handleSizePx}px ${columnPixels[1]}px ${handleSizePx}px minmax(0, ${columnPixels[2]}px)`,
          minHeight: workbenchLayoutLimits.viewerMinHeightPx,
        } satisfies CSSProperties
      }
    >
      <section aria-label="3D Viewer" className="min-h-0 min-w-0 overflow-hidden">
        {viewer}
      </section>
      <ResizeHandle
        label="Viewer와 편집기 너비 조절"
        orientation="vertical"
        onKeyDown={(event) => resizeWithKeyboard(event, 0)}
        onPointerDown={(event) => startDragging(event, 0)}
      />
      <section aria-label="Calculation Source Editor" className="min-h-0 min-w-0 overflow-hidden">
        {editor}
      </section>
      <ResizeHandle
        label="편집기와 출력 너비 조절"
        orientation="vertical"
        onKeyDown={(event) => resizeWithKeyboard(event, 1)}
        onPointerDown={(event) => startDragging(event, 1)}
      />
      <section aria-label="Calculation 출력" className="min-h-0 min-w-0 overflow-hidden">
        {output}
      </section>
    </div>
  )
}
