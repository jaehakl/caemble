import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function ResizableWorkbenchSplit({
  viewer,
  editor,
  viewerPercent,
  defaultViewerPercent = 50,
  minViewerPercent = 25,
  maxViewerPercent = 75,
  onViewerPercentChange,
  className,
}: {
  viewer: ReactNode
  editor: ReactNode
  viewerPercent?: number
  defaultViewerPercent?: number
  minViewerPercent?: number
  maxViewerPercent?: number
  onViewerPercentChange?: (viewerPercent: number) => void
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [internalPercent, setInternalPercent] = useState(defaultViewerPercent)
  const [resizing, setResizing] = useState(false)
  const clampPercent = (value: number) => Math.min(maxViewerPercent, Math.max(minViewerPercent, value))
  const currentPercent = clampPercent(viewerPercent ?? internalPercent)

  const updatePercent = (value: number) => {
    const nextPercent = clampPercent(value)
    if (viewerPercent === undefined) setInternalPercent(nextPercent)
    onViewerPercentChange?.(nextPercent)
  }

  useEffect(() => {
    if (!resizing) return

    const handlePointerMove = (event: PointerEvent) => {
      const bounds = containerRef.current?.getBoundingClientRect()
      if (!bounds || bounds.width <= 0) return
      updatePercent(((event.clientX - bounds.left) / bounds.width) * 100)
    }
    const stopResizing = () => setResizing(false)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
    }
  })

  const handleSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 5 : 2
    let nextPercent: number | null = null
    if (event.key === 'ArrowLeft') nextPercent = currentPercent - step
    if (event.key === 'ArrowRight') nextPercent = currentPercent + step
    if (event.key === 'Home') nextPercent = minViewerPercent
    if (event.key === 'End') nextPercent = maxViewerPercent
    if (nextPercent === null) return
    event.preventDefault()
    updatePercent(nextPercent)
  }

  return (
    <div
      className={cn('grid min-h-0 min-w-0 flex-1 overflow-hidden', className)}
      ref={containerRef}
      style={{ gridTemplateColumns: `calc(${currentPercent}% - 0.25rem) 0.5rem minmax(0, 1fr)` }}
    >
      <section aria-label="3D Viewer" className="min-h-0 min-w-0 overflow-hidden">
        {viewer}
      </section>
      <div
        aria-label="Viewer와 Editor 크기 조절"
        aria-orientation="vertical"
        aria-valuemax={maxViewerPercent}
        aria-valuemin={minViewerPercent}
        aria-valuenow={Math.round(currentPercent)}
        aria-valuetext={`Viewer ${Math.round(currentPercent)}%`}
        className={cn(
          'relative cursor-col-resize bg-border transition-colors outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-muted-foreground/40 hover:bg-primary/20 focus-visible:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
          resizing && 'bg-primary/25',
        )}
        onKeyDown={handleSeparatorKeyDown}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.preventDefault()
          setResizing(true)
        }}
        role="separator"
        tabIndex={0}
      />
      <section aria-label="Editor" className="flex min-h-0 min-w-0 overflow-hidden">
        {editor}
      </section>
    </div>
  )
}
