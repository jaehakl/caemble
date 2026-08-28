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
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
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
type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

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

function BarsEditor({
  disabled,
  maximum,
  minimum,
  values,
  onChange,
}: {
  disabled: boolean
  maximum: number
  minimum: number
  values: readonly number[]
  onChange: (values: readonly number[], activeIndex: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useCanvasSize(canvasRef)
  const [activeIndex, setActiveIndex] = useState(0)
  const [input, setInput] = useState(String(values[activeIndex] ?? minimum))

  useEffect(() => setInput(String(values[activeIndex] ?? minimum)), [activeIndex, minimum, values])
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
      const ratioValue = maximum === minimum ? 1 : (value - minimum) / (maximum - minimum)
      const barHeight = Math.max(1, ratioValue * height)
      context.fillStyle = index === activeIndex ? '#1d4ed8' : '#3b82f6'
      context.fillRect(left + index * slot + slot * 0.12, top + height - barHeight, slot * 0.76, barHeight)
    })
    context.fillStyle = '#64748b'
    context.font = '11px sans-serif'
    context.textAlign = 'right'
    context.fillText(String(maximum), left - 7, top + 4)
    context.fillText(String(minimum), left - 7, top + height)
    context.textAlign = 'center'
    const labelStep = Math.max(1, Math.ceil(values.length / 12))
    for (let index = 0; index < values.length; index += labelStep) {
      context.fillText(String(index), left + (index + 0.5) * slot, top + height + 18)
    }
  }, [activeIndex, maximum, minimum, size, values])

  const applyPointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || maximum === minimum) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const left = 54
    const top = 18
    const width = Math.max(1, bounds.width - left - 16)
    const height = Math.max(1, bounds.height - top - 34)
    const index = varsBarIndex(event.clientX - bounds.left - left, width, values.length)
    const value = varsValueFromVerticalPosition(event.clientY - bounds.top - top, height, minimum, maximum)
    const next = [...values]
    next[index] = value
    setActiveIndex(index)
    onChange(next, index)
  }
  const applyInput = () => {
    const value = Number(input)
    if (!Number.isFinite(value) || value < minimum || value > maximum) return
    const next = [...values]
    next[activeIndex] = value
    onChange(next, activeIndex)
  }
  const inputNumber = Number(input)
  const inputValid =
    input.trim() !== '' && Number.isFinite(inputNumber) && inputNumber >= minimum && inputNumber <= maximum

  return (
    <div className="space-y-3">
      <canvas
        aria-label={values.length === 1 ? 'Scalar variable bar' : 'One-dimensional variable bars'}
        className="h-[min(44vh,360px)] w-full touch-none rounded border bg-white"
        ref={canvasRef}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          applyPointer(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) applyPointer(event)
        }}
      />
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 text-xs font-medium">
          <span className="mb-1 block">index {activeIndex}</span>
          <Input
            aria-invalid={!inputValid}
            disabled={disabled || maximum === minimum}
            max={maximum}
            min={minimum}
            step="any"
            type="number"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && applyInput()}
          />
        </label>
        <Button disabled={disabled || maximum === minimum || !inputValid} type="button" onClick={applyInput}>
          Apply
        </Button>
      </div>
    </div>
  )
}

function HeatmapCanvas({
  columns,
  disabled,
  maximum,
  minimum,
  rows,
  selection,
  sliceIndex,
  values,
  onSelect,
  onWheelSelection,
}: {
  columns: number
  disabled: boolean
  maximum: number
  minimum: number
  rows: number
  selection: Selection | null
  sliceIndex: number
  values: readonly number[]
  onSelect: (selection: Selection) => void
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
  }, [columns, maximum, minimum, rows, selection, size, sliceIndex, values])

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
      aria-label={`Variable heatmap slice ${sliceIndex}`}
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
        const anchor = anchorRef.current
        if (!anchor || !event.currentTarget.hasPointerCapture(event.pointerId)) return
        const next = cell(event)
        onSelect({
          sliceIndex,
          rectangle: rectangleFromCells(anchor.row, anchor.column, next.row, next.column),
        })
      }}
      onPointerUp={() => {
        anchorRef.current = null
      }}
      onWheel={onWheelSelection}
    />
  )
}

function HeatmapsEditor({
  disabled,
  maximum,
  minimum,
  shape,
  values,
  onChange,
}: {
  disabled: boolean
  maximum: number
  minimum: number
  shape: readonly number[]
  values: readonly number[]
  onChange: (values: readonly number[]) => void
}) {
  const rows = shape[shape.length - 2] ?? 1
  const columns = shape[shape.length - 1] ?? 1
  const sliceCount = tensorSliceCount(shape)
  const pageSize = shape.length > 2 ? 8 : 1
  const pageCount = Math.max(1, Math.ceil(sliceCount / pageSize))
  const [page, setPage] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [input, setInput] = useState('')
  const inputNumber = Number(input)
  const inputValid =
    input.trim() !== '' && Number.isFinite(inputNumber) && inputNumber >= minimum && inputNumber <= maximum
  const pageStart = page * pageSize
  const slices = Array.from({ length: Math.min(pageSize, sliceCount - pageStart) }, (_item, index) => pageStart + index)

  useEffect(() => setSelection(null), [page])
  const changeSelection = (update: (value: number) => number) => {
    if (!selection) return
    onChange(updateTensorRectangle(values, rows, columns, selection.sliceIndex, selection.rectangle, update))
  }
  const wheel = (event: WheelEvent<HTMLCanvasElement>, sliceIndex: number) => {
    if (disabled || maximum === minimum || selection?.sliceIndex !== sliceIndex) return
    event.preventDefault()
    const step = varsWheelStep({ shape, min: minimum, max: maximum }, event.shiftKey, event.altKey)
    const direction = event.deltaY < 0 ? 1 : -1
    changeSelection((value) => clampVarsValue(value + direction * step, minimum, maximum))
  }

  return (
    <div className="space-y-3">
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
      <div className={shape.length > 2 ? 'grid max-h-[55vh] grid-cols-1 gap-3 overflow-auto pr-1 md:grid-cols-2' : ''}>
        {slices.map((sliceIndex) => (
          <section className="space-y-1" key={sliceIndex}>
            {shape.length > 2 ? (
              <div className="font-mono text-[11px] text-muted-foreground">
                [{tensorSliceCoordinates(shape, sliceIndex).join(', ')}]
              </div>
            ) : null}
            <HeatmapCanvas
              columns={columns}
              disabled={disabled}
              maximum={maximum}
              minimum={minimum}
              rows={rows}
              selection={selection}
              sliceIndex={sliceIndex}
              values={values}
              onSelect={setSelection}
              onWheelSelection={(event) => wheel(event, sliceIndex)}
            />
          </section>
        ))}
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
            disabled={disabled || maximum === minimum || !selection}
            max={maximum}
            min={minimum}
            placeholder="Selected region value"
            step="any"
            type="number"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter' && inputValid) changeSelection(() => inputNumber)
            }}
          />
        </label>
        <Button
          disabled={disabled || maximum === minimum || !selection || !inputValid}
          type="button"
          onClick={() => changeSelection(() => inputNumber)}
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

function VariableEditor({
  disabled,
  entry,
  name,
  value,
  onChange,
}: {
  disabled: boolean
  entry: VarsSchema[string]
  name: string
  value: Tensor
  onChange: (value: Tensor) => void
}) {
  const [values, setValues] = useState(() => flattenVarsTensor(value, entry.shape, name))
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<readonly number[] | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const update = (next: readonly number[]) => {
    setValues([...next])
    pendingRef.current = next
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending !== null) onChangeRef.current(varsTensorFromFlat(pending, entry.shape))
    })
  }
  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
      if (pendingRef.current !== null) onChangeRef.current(varsTensorFromFlat(pendingRef.current, entry.shape))
    },
    [],
  )

  return entry.shape.length <= 1 ? (
    <BarsEditor
      disabled={disabled}
      maximum={entry.max}
      minimum={entry.min}
      values={values}
      onChange={(next) => update(next)}
    />
  ) : (
    <HeatmapsEditor
      disabled={disabled}
      maximum={entry.max}
      minimum={entry.min}
      shape={entry.shape}
      values={values}
      onChange={update}
    />
  )
}

export function VarsPanel({
  candidateSessionKey,
  disabled,
  schema,
  vars,
  onVariableChange,
}: {
  candidateSessionKey: string
  disabled: boolean
  schema: VarsSchema | null
  vars: Readonly<Vars> | null
  onVariableChange: (key: string, value: Tensor) => void
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const previousSessionRef = useRef(candidateSessionKey)
  const schemaKey = useMemo(
    () =>
      schema
        ? JSON.stringify(Object.entries(schema).map(([key, entry]) => [key, entry.shape, entry.min, entry.max]))
        : 'none',
    [schema],
  )
  const previousSchemaRef = useRef(schemaKey)
  useEffect(() => {
    if (previousSessionRef.current !== candidateSessionKey || previousSchemaRef.current !== schemaKey) {
      setSelectedKey(null)
    }
    previousSessionRef.current = candidateSessionKey
    previousSchemaRef.current = schemaKey
  }, [candidateSessionKey, schemaKey])

  const entry = selectedKey && schema ? schema[selectedKey] : undefined
  const value = selectedKey && vars ? vars[selectedKey] : undefined
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded border">
        {!schema || !vars ? (
          <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
            {disabled ? <LoaderCircle className="size-4 animate-spin" /> : '평가된 Candidate가 없습니다.'}
          </div>
        ) : Object.keys(schema).length ? (
          <div className="grid gap-2 p-2">
            {Object.entries(schema).map(([key, item]) => (
              <button
                className="rounded border px-2 py-2 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={disabled || vars[key] === undefined}
                key={key}
                type="button"
                onClick={() => setSelectedKey(key)}
              >
                <span className="block truncate font-mono font-medium">{key}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                  <Badge>{item.shape.length === 0 ? 'scalar' : JSON.stringify(item.shape)}</Badge>
                  <span>
                    {item.min} – {item.max}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
            varsSchema 항목이 없습니다.
          </div>
        )}
      </div>
      <Dialog
        modal={false}
        open={Boolean(selectedKey && entry && value !== undefined)}
        onOpenChange={(open) => !open && setSelectedKey(null)}
      >
        {selectedKey && entry && value !== undefined ? (
          <DialogContent
            className="top-32 right-2 bottom-9 left-auto max-h-none w-[min(48vw,900px)] max-w-none translate-x-0 translate-y-0 overflow-hidden p-4 sm:max-w-none"
            hideOverlay
            onInteractOutside={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle className="font-mono">{selectedKey}</DialogTitle>
              <DialogDescription>
                shape {JSON.stringify(entry.shape)} · range [{entry.min}, {entry.max}]
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 overflow-auto">
              <VariableEditor
                disabled={disabled}
                entry={entry}
                key={`${candidateSessionKey}:${schemaKey}:${selectedKey}`}
                name={selectedKey}
                value={value}
                onChange={(next) => onVariableChange(selectedKey, next)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSelectedKey(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  )
}
