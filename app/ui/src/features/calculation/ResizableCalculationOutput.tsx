import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import type { CalculationPreviewState } from './CalculationOutputChart'
import { CalculationOutputChart } from './CalculationOutputChart'
import { CalculationReturnSummary } from './CalculationReturnSummary'

const handleHeight = 4
const chartMinimum = 160
const returnMinimum = 112

export function ResizableCalculationOutput({
  chartRatio,
  comparisonMessage,
  measurementId,
  onChartRatioChange,
  preview,
  scalarValues,
}: {
  chartRatio: number
  comparisonMessage?: string
  measurementId?: number | null
  onChartRatioChange: (ratio: number) => void
  preview: CalculationPreviewState
  scalarValues?: readonly number[]
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const [drag, setDrag] = useState<{ startChart: number; startClient: number } | null>(null)
  const available = Math.max(0, height - handleHeight)
  const canConstrain = available >= chartMinimum + returnMinimum
  const chartHeight = canConstrain
    ? Math.min(available - returnMinimum, Math.max(chartMinimum, chartRatio * available))
    : available * Math.min(0.9, Math.max(0.1, chartRatio))

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height))
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!drag) return
    const move = (event: PointerEvent) => {
      if (available <= 0) return
      const unconstrained = drag.startChart + event.clientY - drag.startClient
      const next = canConstrain
        ? Math.min(available - returnMinimum, Math.max(chartMinimum, unconstrained))
        : Math.min(available, Math.max(0, unconstrained))
      onChartRatioChange(next / available)
    }
    const stop = () => setDrag(null)
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
  }, [available, canConstrain, drag, onChartRatioChange])

  const keyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (available <= 0) return
    const step = event.shiftKey ? 64 : 16
    let next = chartHeight
    if (event.key === 'ArrowUp') next -= step
    else if (event.key === 'ArrowDown') next += step
    else if (event.key === 'Home') next = canConstrain ? chartMinimum : 0
    else if (event.key === 'End') next = canConstrain ? available - returnMinimum : available
    else return
    event.preventDefault()
    const constrained = canConstrain
      ? Math.min(available - returnMinimum, Math.max(chartMinimum, next))
      : Math.min(available, Math.max(0, next))
    onChartRatioChange(constrained / available)
  }

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    setDrag({ startChart: chartHeight, startClient: event.clientY })
  }

  return (
    <div
      className="grid h-full min-h-0 overflow-hidden"
      ref={containerRef}
      style={{ gridTemplateRows: `${chartHeight}px ${handleHeight}px minmax(0, 1fr)` }}
    >
      <div className="min-h-0 overflow-hidden">
        <CalculationOutputChart
          comparisonMessage={comparisonMessage}
          measurementId={measurementId}
          preview={preview}
          scalarValues={scalarValues}
        />
      </div>
      <div
        aria-label="Output Chart와 Return 요약 높이 조절"
        aria-orientation="horizontal"
        className="relative z-10 cursor-row-resize bg-border outline-none after:absolute after:inset-x-0 after:-inset-y-1 hover:bg-primary focus-visible:bg-primary"
        role="separator"
        tabIndex={0}
        onKeyDown={keyDown}
        onPointerDown={pointerDown}
      />
      <div className="min-h-0 overflow-hidden">
        <CalculationReturnSummary preview={preview} />
      </div>
    </div>
  )
}
