import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ResizeHandle } from '@/shared/layout/ResizeHandle'
import { cn } from '@/lib/utils'
import { workbenchLayoutLimits, type BottomDockMode } from '../types'

export function WorkbenchConsoleLayout({
  children,
  console: consoleContent,
  mode,
  heightRatio,
  onHeightRatioChange,
  className,
}: {
  children: ReactNode
  console: ReactNode
  mode: BottomDockMode
  heightRatio: number
  onHeightRatioChange: (ratio: number) => void
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerHeight, setContainerHeight] = useState(640)
  const [dragStart, setDragStart] = useState<{ clientY: number; height: number } | null>(null)
  const maximum = Math.max(
    workbenchLayoutLimits.bottomMinHeightPx,
    containerHeight - workbenchLayoutLimits.resizeHandlePx - workbenchLayoutLimits.viewerMinHeightPx,
  )
  const height = Math.min(maximum, Math.max(workbenchLayoutLimits.bottomMinHeightPx, heightRatio * containerHeight))

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const updateHeight = (next: number) => {
      if (next > 0) setContainerHeight(next)
    }
    updateHeight(container.getBoundingClientRect().height)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateHeight(entry.contentRect.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!dragStart) return
    const move = (event: PointerEvent) => {
      const next = Math.min(
        maximum,
        Math.max(workbenchLayoutLimits.bottomMinHeightPx, dragStart.height - event.clientY + dragStart.clientY),
      )
      onHeightRatioChange(next / containerHeight)
    }
    const stop = () => setDragStart(null)
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    document.body.style.cursor = 'row-resize'
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
  }, [containerHeight, dragStart, maximum, onHeightRatioChange])

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16
    let next: number | null = null
    if (event.key === 'ArrowDown') next = height - step
    if (event.key === 'ArrowUp') next = height + step
    if (event.key === 'Home') next = workbenchLayoutLimits.bottomMinHeightPx
    if (event.key === 'End') next = maximum
    if (next === null) return
    event.preventDefault()
    onHeightRatioChange(Math.min(maximum, Math.max(workbenchLayoutLimits.bottomMinHeightPx, next)) / containerHeight)
  }

  const startDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    setDragStart({ clientY: event.clientY, height })
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden', className)} ref={containerRef}>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {mode === 'console' ? (
        <ResizeHandle
          label="Console 높이 조절"
          maximum={maximum}
          minimum={workbenchLayoutLimits.bottomMinHeightPx}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startDragging}
          orientation="horizontal"
          value={height}
        />
      ) : null}
      <div
        className="shrink-0 overflow-hidden"
        style={{ height: mode === 'console' ? height : workbenchLayoutLimits.bottomCollapsedHeightPx }}
      >
        {consoleContent}
      </div>
    </div>
  )
}
