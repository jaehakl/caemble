import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Tensor } from '@/lib/cad'
import { fitTensorDisplayDomain } from './tensorDisplayDomain'
import {
  clampVarsValue,
  flattenVarsTensor,
  rectangleFromCells,
  tensorCellFromPoint,
  tensorSliceCoordinates,
  tensorSliceCount,
  updateTensorRectangle,
  varsBarIndex,
  varsTensorFromFlat,
  varsValueFromVerticalPosition,
  varsWheelStep,
  type TensorRectangle,
} from './varsTensor'

type Selection = Readonly<{ sliceIndex: number; rectangle: TensorRectangle }>
type HoveredCell = Readonly<{ sliceIndex: number; row: number; column: number }>

export type TensorEditorComparisonStatus = 'ready' | 'updating' | 'unavailable' | 'incompatible'

export type TensorEditorComparisonSeries = Readonly<{
  color: string
  id: string
  label: string
  lineDash?: readonly number[]
  message?: string | null
  status: TensorEditorComparisonStatus
  value: Tensor | null
}>

export type TensorEditorComparison = Readonly<{
  primaryColor: string
  primaryLabel: string
  series: readonly TensorEditorComparisonSeries[]
}>

export type TensorEditorAxis = Readonly<{
  name: string
  ticks: readonly (number | string)[]
  unit?: string
}>

export type TensorEditorProps = Readonly<{
  axes?: readonly TensorEditorAxis[]
  comparison?: TensorEditorComparison
  constraintMaximum?: number
  constraintMinimum?: number
  disabled?: boolean
  displayDomainResetKey?: string | number
  label: string
  maximum: number
  minimum: number
  selectionResetKey?: string | number
  shape: readonly number[]
  value: Tensor
  onValueChange: (value: Tensor) => void
}>

type FlatComparisonSeries = Omit<TensorEditorComparisonSeries, 'value'> & Readonly<{ values: readonly number[] | null }>

function heatmapColor(value: number, minimum: number, maximum: number) {
  const ratio = maximum === minimum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))
  return `hsl(${260 - ratio * 210} 78% ${28 + ratio * 34}%)`
}

function useCanvasSize(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  const [size, setSize] = useState({ width: 640, height: 320 })
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const update = () => {
      const bounds = canvas.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0) setSize({ width: bounds.width, height: bounds.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvasRef])
  return size
}

function formatComparisonValue(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if ((absolute > 0 && absolute < 0.001) || absolute >= 1_000_000) return value.toExponential(3)
  return new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 7 }).format(value)
}

function ComparisonLegend({
  activeIndex,
  comparison,
  primaryValues,
}: {
  activeIndex: number
  comparison: Readonly<{
    primaryColor: string
    primaryLabel: string
    series: readonly FlatComparisonSeries[]
  }>
  primaryValues: readonly number[]
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-[11px]" data-tensor-comparison-legend="true">
      <span className="inline-flex min-w-0 items-center gap-1.5" data-comparison-series="primary">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: comparison.primaryColor }} />
        <span className="font-medium">{comparison.primaryLabel}</span>
        <span className="font-mono text-muted-foreground">{formatComparisonValue(primaryValues[activeIndex])}</span>
      </span>
      {comparison.series.map((series) => (
        <span
          className="inline-flex min-w-0 items-center gap-1.5"
          data-comparison-series={series.id}
          key={series.id}
          title={series.message ?? undefined}
        >
          <span
            className="w-3 shrink-0 border-t-2"
            style={{ borderColor: series.color, borderTopStyle: series.lineDash?.length ? 'dashed' : 'solid' }}
          />
          <span className="font-medium">{series.label}</span>
          <span className="font-mono text-muted-foreground">
            {series.status === 'ready'
              ? formatComparisonValue(series.values?.[activeIndex])
              : series.status === 'updating'
                ? 'Updating…'
                : series.status === 'incompatible'
                  ? 'Incompatible'
                  : 'Unavailable'}
          </span>
        </span>
      ))}
    </div>
  )
}

function BarsEditor({
  axes,
  comparison,
  constraintMaximum,
  constraintMinimum,
  disabled,
  label,
  maximum,
  minimum,
  selectionResetKey,
  values,
  onCommit,
  onPreview,
}: {
  axes: readonly TensorEditorAxis[]
  comparison?: Readonly<{
    primaryColor: string
    primaryLabel: string
    series: readonly FlatComparisonSeries[]
  }>
  constraintMaximum: number
  constraintMinimum: number
  disabled: boolean
  label: string
  maximum: number
  minimum: number
  selectionResetKey?: string | number
  values: readonly number[]
  onCommit: (values: readonly number[]) => void
  onPreview: (values: readonly number[]) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useCanvasSize(canvasRef)
  const [activeIndex, setActiveIndex] = useState(0)
  const [input, setInput] = useState(String(values[activeIndex] ?? minimum))
  const inputTimerRef = useRef<number | null>(null)
  const latestValuesRef = useRef(values)
  latestValuesRef.current = values

  useEffect(() => {
    if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
    inputTimerRef.current = null
    setInput(String(values[activeIndex] ?? minimum))
  }, [activeIndex, minimum, selectionResetKey, values])
  useEffect(
    () => () => {
      if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
    },
    [],
  )
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.width * ratio))
    canvas.height = Math.max(1, Math.round(size.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const left = 54
    const top = 18
    const right = 16
    const bottom = 34
    const width = Math.max(1, size.width - left - right)
    const height = Math.max(1, size.height - top - bottom)
    context.fillStyle = '#f8fafc'
    context.fillRect(left, top, width, height)
    context.strokeStyle = '#94a3b8'
    context.beginPath()
    context.moveTo(left, top)
    context.lineTo(left, top + height)
    context.lineTo(left + width, top + height)
    context.stroke()
    const slot = width / values.length
    values.forEach((value, index) => {
      const ratioValue = maximum === minimum ? 1 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)))
      const barHeight = Math.max(1, ratioValue * height)
      context.fillStyle = comparison?.primaryColor ?? (index === activeIndex ? '#1d4ed8' : '#3b82f6')
      context.globalAlpha = index === activeIndex ? 1 : 0.82
      context.fillRect(left + index * slot + slot * 0.12, top + height - barHeight, slot * 0.76, barHeight)
    })
    context.globalAlpha = 1
    comparison?.series.forEach((series) => {
      if (series.status !== 'ready' || !series.values?.length) return
      context.strokeStyle = series.color
      context.fillStyle = series.color
      context.lineWidth = 2.5
      context.setLineDash(series.lineDash ? [...series.lineDash] : [])
      context.beginPath()
      series.values.forEach((value, index) => {
        const x = left + (index + 0.5) * slot
        const y = Math.max(
          top,
          Math.min(top + height, top + ((maximum - value) * height) / Math.max(Number.EPSILON, maximum - minimum)),
        )
        if (index === 0) context.moveTo(x, y)
        else context.lineTo(x, y)
      })
      context.stroke()
      series.values.forEach((value, index) => {
        const x = left + (index + 0.5) * slot
        const y = Math.max(
          top,
          Math.min(top + height, top + ((maximum - value) * height) / Math.max(Number.EPSILON, maximum - minimum)),
        )
        context.beginPath()
        context.arc(x, y, index === activeIndex ? 4 : 2.5, 0, Math.PI * 2)
        context.fill()
      })
      context.setLineDash([])
    })
    context.fillStyle = '#64748b'
    context.font = '11px sans-serif'
    context.textAlign = 'right'
    context.fillText(String(maximum), left - 7, top + 4)
    context.fillText(String(minimum), left - 7, top + height)
    context.textAlign = 'center'
    const labelStep = Math.max(1, Math.ceil(values.length / 12))
    for (let index = 0; index < values.length; index += labelStep) {
      context.fillText(String(axes[0]?.ticks[index] ?? index), left + (index + 0.5) * slot, top + height + 18)
    }
  }, [activeIndex, axes, comparison, maximum, minimum, size, values])

  const indexFromPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return varsBarIndex(event.clientX - bounds.left - 54, Math.max(1, bounds.width - 70), values.length)
  }

  const applyPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || maximum === minimum) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const top = 18
    const height = Math.max(1, bounds.height - top - 34)
    const index = indexFromPointer(event)
    const value = clampVarsValue(
      varsValueFromVerticalPosition(event.clientY - bounds.top - top, height, minimum, maximum),
      constraintMinimum,
      constraintMaximum,
    )
    const next = [...latestValuesRef.current]
    next[index] = value
    latestValuesRef.current = next
    setActiveIndex(index)
    onPreview(next)
    return next
  }
  const applyInput = () => {
    const value = Number(input)
    if (!Number.isFinite(value) || value < constraintMinimum || value > constraintMaximum) return
    if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
    inputTimerRef.current = null
    const next = [...latestValuesRef.current]
    next[activeIndex] = value
    latestValuesRef.current = next
    onCommit(next)
  }
  const inputNumber = Number(input)
  const inputValid =
    input.trim() !== '' &&
    Number.isFinite(inputNumber) &&
    inputNumber >= constraintMinimum &&
    inputNumber <= constraintMaximum

  return (
    <div className="space-y-3">
      {comparison ? (
        <ComparisonLegend activeIndex={activeIndex} comparison={comparison} primaryValues={values} />
      ) : null}
      <canvas
        aria-label={values.length === 1 ? `${label} scalar bar` : `${label} one-dimensional bars`}
        className="h-[min(44vh,360px)] w-full touch-none rounded border bg-white"
        ref={canvasRef}
        tabIndex={0}
        onPointerDown={(event) => {
          if (disabled || maximum === minimum) return
          event.currentTarget.setPointerCapture(event.pointerId)
          applyPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) applyPointer(event)
          else if (comparison) setActiveIndex(indexFromPointer(event))
        }}
        onPointerUp={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          const next = applyPointer(event) ?? latestValuesRef.current
          event.currentTarget.releasePointerCapture(event.pointerId)
          onCommit(next)
        }}
        onPointerCancel={() => onCommit(latestValuesRef.current)}
      />
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 text-xs font-medium">
          <span className="mb-1 block">index {activeIndex}</span>
          <Input
            aria-invalid={!inputValid}
            disabled={disabled || constraintMaximum === constraintMinimum}
            max={constraintMaximum}
            min={constraintMinimum}
            step="any"
            type="number"
            value={input}
            onBlur={() => inputValid && applyInput()}
            onChange={(event) => {
              const nextInput = event.target.value
              setInput(nextInput)
              if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
              const nextValue = Number(nextInput)
              if (
                nextInput.trim() !== '' &&
                Number.isFinite(nextValue) &&
                nextValue >= constraintMinimum &&
                nextValue <= constraintMaximum
              ) {
                const index = activeIndex
                inputTimerRef.current = window.setTimeout(() => {
                  const next = [...latestValuesRef.current]
                  next[index] = nextValue
                  latestValuesRef.current = next
                  onCommit(next)
                  inputTimerRef.current = null
                }, 350)
              }
            }}
            onKeyDown={(event) => event.key === 'Enter' && applyInput()}
          />
        </label>
        <Button
          disabled={disabled || constraintMaximum === constraintMinimum || !inputValid}
          type="button"
          onClick={applyInput}
        >
          Apply
        </Button>
      </div>
    </div>
  )
}

function HeatmapCanvas({
  columns,
  disabled,
  label,
  maximum,
  minimum,
  rows,
  hoveredCell,
  selection,
  sliceIndex,
  values,
  onSelect,
  onHover,
  onWheelSelection,
}: {
  columns: number
  disabled: boolean
  label: string
  maximum: number
  minimum: number
  rows: number
  hoveredCell: HoveredCell | null
  selection: Selection | null
  sliceIndex: number
  values: readonly number[]
  onSelect: (selection: Selection) => void
  onHover: (cell: HoveredCell | null) => void
  onWheelSelection: (event: WheelEvent<HTMLCanvasElement>) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const anchorRef = useRef<Readonly<{ row: number; column: number }> | null>(null)
  const size = useCanvasSize(canvasRef)
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.width * ratio))
    canvas.height = Math.max(1, Math.round(size.height * ratio))
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    const cellWidth = size.width / columns
    const cellHeight = size.height / rows
    const offset = sliceIndex * rows * columns
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        context.fillStyle = heatmapColor(values[offset + row * columns + column], minimum, maximum)
        context.fillRect(column * cellWidth, row * cellHeight, Math.ceil(cellWidth) + 0.5, Math.ceil(cellHeight) + 0.5)
      }
    }
    if (selection?.sliceIndex === sliceIndex) {
      const rectangle = selection.rectangle
      context.strokeStyle = '#f8fafc'
      context.lineWidth = 3
      context.strokeRect(
        rectangle.columnStart * cellWidth + 1.5,
        rectangle.rowStart * cellHeight + 1.5,
        (rectangle.columnEnd - rectangle.columnStart + 1) * cellWidth - 3,
        (rectangle.rowEnd - rectangle.rowStart + 1) * cellHeight - 3,
      )
      context.strokeStyle = '#0f172a'
      context.lineWidth = 1
      context.strokeRect(
        rectangle.columnStart * cellWidth + 0.5,
        rectangle.rowStart * cellHeight + 0.5,
        (rectangle.columnEnd - rectangle.columnStart + 1) * cellWidth - 1,
        (rectangle.rowEnd - rectangle.rowStart + 1) * cellHeight - 1,
      )
    }
    if (hoveredCell?.sliceIndex === sliceIndex) {
      context.strokeStyle = '#ffffff'
      context.lineWidth = 3
      context.strokeRect(
        hoveredCell.column * cellWidth + 1.5,
        hoveredCell.row * cellHeight + 1.5,
        cellWidth - 3,
        cellHeight - 3,
      )
      context.strokeStyle = '#0f172a'
      context.lineWidth = 1
      context.strokeRect(
        hoveredCell.column * cellWidth + 0.5,
        hoveredCell.row * cellHeight + 0.5,
        cellWidth - 1,
        cellHeight - 1,
      )
    }
  }, [columns, hoveredCell, maximum, minimum, rows, selection, size, sliceIndex, values])

  const cell = (event: PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return tensorCellFromPoint(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      bounds.width,
      bounds.height,
      rows,
      columns,
    )
  }
  return (
    <canvas
      aria-label={`${label} heatmap slice ${sliceIndex}`}
      className="aspect-[4/3] w-full touch-none rounded border bg-white"
      ref={canvasRef}
      tabIndex={0}
      onPointerDown={(event) => {
        if (disabled || maximum === minimum) return
        const next = cell(event)
        anchorRef.current = next
        event.currentTarget.setPointerCapture(event.pointerId)
        onSelect({ sliceIndex, rectangle: rectangleFromCells(next.row, next.column, next.row, next.column) })
      }}
      onPointerMove={(event) => {
        const next = cell(event)
        onHover({ sliceIndex, row: next.row, column: next.column })
        const anchor = anchorRef.current
        if (!anchor || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        onSelect({
          sliceIndex,
          rectangle: rectangleFromCells(anchor.row, anchor.column, next.row, next.column),
        })
      }}
      onPointerUp={() => {
        anchorRef.current = null
      }}
      onPointerLeave={() => onHover(null)}
      onWheel={onWheelSelection}
    />
  )
}

function HeatmapsEditor({
  axes,
  comparison,
  constraintMaximum,
  constraintMinimum,
  disabled,
  label,
  maximum,
  minimum,
  selectionResetKey,
  shape,
  values,
  onCommit,
  onPreview,
}: {
  axes: readonly TensorEditorAxis[]
  comparison?: Readonly<{
    primaryColor: string
    primaryLabel: string
    series: readonly FlatComparisonSeries[]
  }>
  constraintMaximum: number
  constraintMinimum: number
  disabled: boolean
  label: string
  maximum: number
  minimum: number
  selectionResetKey?: string | number
  shape: readonly number[]
  values: readonly number[]
  onCommit: (values: readonly number[]) => void
  onPreview: (values: readonly number[]) => void
}) {
  const rows = shape[shape.length - 2] ?? 1
  const columns = shape[shape.length - 1] ?? 1
  const sliceCount = tensorSliceCount(shape)
  const pageSize = shape.length > 2 ? 8 : 1
  const pageCount = Math.max(1, Math.ceil(sliceCount / pageSize))
  const [page, setPage] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [hoveredCell, setHoveredCell] = useState<HoveredCell | null>(null)
  const [input, setInput] = useState('')
  const inputTimerRef = useRef<number | null>(null)
  const wheelTimerRef = useRef<number | null>(null)
  const latestValuesRef = useRef(values)
  latestValuesRef.current = values
  const inputNumber = Number(input)
  const inputValid =
    input.trim() !== '' &&
    Number.isFinite(inputNumber) &&
    inputNumber >= constraintMinimum &&
    inputNumber <= constraintMaximum
  const pageStart = page * pageSize
  const slices = Array.from({ length: Math.min(pageSize, sliceCount - pageStart) }, (_item, index) => pageStart + index)
  const hoverIndex = hoveredCell
    ? hoveredCell.sliceIndex * rows * columns + hoveredCell.row * columns + hoveredCell.column
    : 0
  const hoverCoordinates = hoveredCell
    ? `${String(axes[axes.length - 2]?.ticks[hoveredCell.row] ?? hoveredCell.row)}, ${String(axes[axes.length - 1]?.ticks[hoveredCell.column] ?? hoveredCell.column)}`
    : null

  useEffect(() => setSelection(null), [page])
  useEffect(() => {
    if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current)
    inputTimerRef.current = null
    wheelTimerRef.current = null
    setInput('')
    setSelection(null)
  }, [selectionResetKey])
  const changeSelection = (update: (value: number) => number, commit: boolean) => {
    if (!selection) return
    const next = updateTensorRectangle(
      latestValuesRef.current,
      rows,
      columns,
      selection.sliceIndex,
      selection.rectangle,
      update,
    )
    latestValuesRef.current = next
    if (commit) onCommit(next)
    else onPreview(next)
    return next
  }
  const wheel = (event: WheelEvent<HTMLCanvasElement>, sliceIndex: number) => {
    if (disabled || maximum === minimum || selection?.sliceIndex !== sliceIndex) return
    event.preventDefault()
    const step = varsWheelStep({ shape, min: minimum, max: maximum }, event.shiftKey, event.altKey)
    const direction = event.deltaY < 0 ? 1 : -1
    changeSelection((value) => clampVarsValue(value + direction * step, constraintMinimum, constraintMaximum), false)
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current)
    wheelTimerRef.current = window.setTimeout(() => {
      onCommit(latestValuesRef.current)
      wheelTimerRef.current = null
    }, 250)
  }

  useEffect(
    () => () => {
      if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
      if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current)
    },
    [],
  )

  return (
    <div className="space-y-3">
      {comparison ? <ComparisonLegend activeIndex={hoverIndex} comparison={comparison} primaryValues={values} /> : null}
      {shape.length > 2 ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">Last two axes · {sliceCount.toLocaleString()} slices</span>
          <div className="flex items-center gap-2">
            <Button
              aria-label="이전 slice 페이지"
              disabled={page === 0}
              size="icon"
              type="button"
              variant="outline"
              onClick={() => setPage((current) => current - 1)}
            >
              <ChevronLeft />
            </Button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <Button
              aria-label="다음 slice 페이지"
              disabled={page + 1 >= pageCount}
              size="icon"
              type="button"
              variant="outline"
              onClick={() => setPage((current) => current + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
      <div
        className={
          comparison && shape.length === 2
            ? 'grid grid-flow-col gap-2 overflow-x-auto pb-1'
            : shape.length > 2
              ? 'grid max-h-[55vh] grid-cols-1 gap-3 overflow-auto pr-1 md:grid-cols-2'
              : ''
        }
        data-comparison-layout={comparison && shape.length === 2 ? 'parallel-heatmaps' : undefined}
        style={
          comparison && shape.length === 2
            ? { gridTemplateColumns: `repeat(${1 + comparison.series.length}, minmax(10rem, 1fr))` }
            : undefined
        }
      >
        {slices.map((sliceIndex) => (
          <section
            className="space-y-1"
            data-comparison-series={comparison && shape.length === 2 ? 'primary' : undefined}
            key={sliceIndex}
          >
            {shape.length > 2 ? (
              <div className="font-mono text-[11px] text-muted-foreground">
                [{tensorSliceCoordinates(shape, sliceIndex).join(', ')}]
              </div>
            ) : comparison ? (
              <div className="flex items-center justify-between gap-1 text-[11px]">
                <span className="inline-flex items-center gap-1 font-medium">
                  <span className="size-2 rounded-sm" style={{ backgroundColor: comparison.primaryColor }} />
                  {comparison.primaryLabel}
                </span>
                <span className="truncate font-mono text-muted-foreground">
                  {hoverCoordinates
                    ? `${hoverCoordinates}: ${formatComparisonValue(values[hoverIndex])}`
                    : 'Hover a cell'}
                </span>
              </div>
            ) : null}
            <HeatmapCanvas
              columns={columns}
              disabled={disabled}
              label={label}
              hoveredCell={hoveredCell}
              maximum={maximum}
              minimum={minimum}
              rows={rows}
              selection={selection}
              sliceIndex={sliceIndex}
              values={values}
              onHover={setHoveredCell}
              onSelect={setSelection}
              onWheelSelection={(event) => wheel(event, sliceIndex)}
            />
            {comparison && axes.length >= 2 ? (
              <p className="truncate text-center text-[10px] text-muted-foreground">
                {axes[0].name} ({axes[0].unit ?? 'unitless'}) ↓ · {axes[1].name} ({axes[1].unit ?? 'unitless'}) →
              </p>
            ) : null}
          </section>
        ))}
        {comparison && shape.length === 2
          ? comparison.series.map((series) => (
              <section className="space-y-1" data-comparison-series={series.id} key={series.id}>
                <div
                  className="flex items-center justify-between gap-1 text-[11px]"
                  title={series.message ?? undefined}
                >
                  <span className="inline-flex items-center gap-1 font-medium">
                    <span className="size-2 rounded-sm" style={{ backgroundColor: series.color }} />
                    {series.label}
                  </span>
                  <span className="truncate font-mono text-muted-foreground">
                    {series.status === 'ready' && series.values
                      ? hoverCoordinates
                        ? `${hoverCoordinates}: ${formatComparisonValue(series.values[hoverIndex])}`
                        : 'Hover a cell'
                      : series.status === 'updating'
                        ? 'Updating…'
                        : series.status === 'incompatible'
                          ? 'Incompatible'
                          : 'Unavailable'}
                  </span>
                </div>
                {series.status === 'ready' && series.values ? (
                  <HeatmapCanvas
                    columns={columns}
                    disabled
                    hoveredCell={hoveredCell}
                    label={`${label} ${series.label}`}
                    maximum={maximum}
                    minimum={minimum}
                    rows={rows}
                    selection={null}
                    sliceIndex={0}
                    values={series.values}
                    onHover={setHoveredCell}
                    onSelect={() => undefined}
                    onWheelSelection={() => undefined}
                  />
                ) : (
                  <div className="grid aspect-[4/3] place-items-center rounded border border-dashed bg-muted/20 p-2 text-center text-xs text-muted-foreground">
                    {series.message ??
                      (series.status === 'updating'
                        ? 'Updating…'
                        : series.status === 'incompatible'
                          ? 'Incompatible data'
                          : 'No comparison data')}
                  </div>
                )}
                {axes.length >= 2 ? (
                  <p className="truncate text-center text-[10px] text-muted-foreground">
                    {axes[0].name} ({axes[0].unit ?? 'unitless'}) ↓ · {axes[1].name} ({axes[1].unit ?? 'unitless'}) →
                  </p>
                ) : null}
              </section>
            ))
          : null}
      </div>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 text-xs font-medium">
          <span className="mb-1 block">
            {selection
              ? `slice ${selection.sliceIndex} · rows ${selection.rectangle.rowStart}–${selection.rectangle.rowEnd} · columns ${selection.rectangle.columnStart}–${selection.rectangle.columnEnd}`
              : 'Select a rectangular region'}
          </span>
          <Input
            aria-invalid={input.trim() !== '' && !inputValid}
            disabled={disabled || constraintMaximum === constraintMinimum || !selection}
            max={constraintMaximum}
            min={constraintMinimum}
            placeholder="Selected region value"
            step="any"
            type="number"
            value={input}
            onBlur={() => {
              if (!inputValid) return
              if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
              inputTimerRef.current = null
              changeSelection(() => inputNumber, true)
            }}
            onChange={(event) => {
              const nextInput = event.target.value
              setInput(nextInput)
              if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
              const nextValue = Number(nextInput)
              if (
                nextInput.trim() !== '' &&
                Number.isFinite(nextValue) &&
                nextValue >= constraintMinimum &&
                nextValue <= constraintMaximum
              ) {
                inputTimerRef.current = window.setTimeout(() => {
                  changeSelection(() => nextValue, true)
                  inputTimerRef.current = null
                }, 350)
              }
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' && inputValid) {
                if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
                inputTimerRef.current = null
                changeSelection(() => inputNumber, true)
              }
            }}
          />
        </label>
        <Button
          disabled={disabled || constraintMaximum === constraintMinimum || !selection || !inputValid}
          type="button"
          onClick={() => {
            if (inputTimerRef.current !== null) window.clearTimeout(inputTimerRef.current)
            inputTimerRef.current = null
            changeSelection(() => inputNumber, true)
          }}
        >
          Apply
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Drag to select. Wheel changes by 1% of the range; Shift uses 10× and Alt uses 0.1×.
      </p>
    </div>
  )
}

export function TensorEditor({
  axes = [],
  comparison,
  disabled = false,
  displayDomainResetKey,
  label,
  maximum,
  minimum,
  selectionResetKey,
  constraintMaximum = maximum,
  constraintMinimum = minimum,
  shape,
  value,
  onValueChange,
}: TensorEditorProps) {
  const controlledValues = useMemo(() => flattenVarsTensor(value, shape, label), [label, shape, value])
  const [values, setValues] = useState(controlledValues)
  const flatComparison = useMemo(
    () =>
      comparison
        ? {
            ...comparison,
            series: comparison.series.map((series): FlatComparisonSeries => {
              if (series.status !== 'ready' || series.value === null) return { ...series, values: null }
              try {
                return { ...series, values: flattenVarsTensor(series.value, shape, `${label} ${series.label}`) }
              } catch (cause: unknown) {
                return {
                  ...series,
                  message: cause instanceof Error ? cause.message : String(cause),
                  status: 'incompatible',
                  values: null,
                }
              }
            }),
          }
        : undefined,
    [comparison, label, shape],
  )
  const requestedDisplayDomainRef = useRef<readonly [number, number]>([minimum, maximum])
  requestedDisplayDomainRef.current = [minimum, maximum]
  const [displayDomain, setDisplayDomain] = useState<readonly [number, number]>([minimum, maximum])
  const shapeRef = useRef(shape)
  const onValueChangeRef = useRef(onValueChange)
  shapeRef.current = shape
  onValueChangeRef.current = onValueChange

  useLayoutEffect(() => {
    setValues(controlledValues)
  }, [controlledValues])
  useLayoutEffect(() => {
    setDisplayDomain(requestedDisplayDomainRef.current)
  }, [displayDomainResetKey])

  const preview = (next: readonly number[]) => {
    setValues([...next])
  }
  const commit = (next: readonly number[]) => {
    setValues([...next])
    onValueChangeRef.current(varsTensorFromFlat(next, shapeRef.current))
  }

  const readyComparisonValues = flatComparison?.series.flatMap((series) => series.values ?? []) ?? []
  const displayedValues = [...values, ...readyComparisonValues]
  const clippedCount = displayedValues.filter((member) => member < displayDomain[0] || member > displayDomain[1]).length
  const editor =
    shape.length <= 1 ? (
      <BarsEditor
        axes={axes}
        comparison={flatComparison}
        constraintMaximum={constraintMaximum}
        constraintMinimum={constraintMinimum}
        disabled={disabled}
        label={label}
        maximum={displayDomain[1]}
        minimum={displayDomain[0]}
        selectionResetKey={selectionResetKey}
        values={values}
        onCommit={commit}
        onPreview={preview}
      />
    ) : (
      <HeatmapsEditor
        axes={axes}
        comparison={flatComparison}
        constraintMaximum={constraintMaximum}
        constraintMinimum={constraintMinimum}
        disabled={disabled}
        label={label}
        maximum={displayDomain[1]}
        minimum={displayDomain[0]}
        selectionResetKey={selectionResetKey}
        shape={shape}
        values={values}
        onCommit={commit}
        onPreview={preview}
      />
    )
  return comparison ? (
    <div className="space-y-2">
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded border bg-muted/20 px-2 py-1.5 text-[11px]"
        data-display-domain-maximum={displayDomain[1]}
        data-display-domain-minimum={displayDomain[0]}
      >
        <span className="font-mono text-muted-foreground">
          Display range [{formatComparisonValue(displayDomain[0])}, {formatComparisonValue(displayDomain[1])}]
        </span>
        <span className="flex items-center gap-2">
          {clippedCount ? (
            <span className="font-medium text-amber-700" data-display-domain-clipped={clippedCount}>
              {clippedCount.toLocaleString()} clipped
            </span>
          ) : null}
          <Button
            aria-label={`${label} display range 맞춤`}
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setDisplayDomain(fitTensorDisplayDomain(displayedValues))}
          >
            Fit
          </Button>
        </span>
      </div>
      {editor}
    </div>
  ) : (
    editor
  )
}
