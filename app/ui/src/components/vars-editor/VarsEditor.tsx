import { useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { TensorEditor, type TensorEditorHandle } from '@/components/tensor-editor'
import { flattenVarsTensor, type Vars } from '@/lib/cad/model'
import type { VarsSchema } from '@/lib/cad/model/vars'

export type VarsEditorProps = Readonly<{
  schema: VarsSchema
  value: Readonly<Vars>
  disabled?: boolean
  resetKey?: string | number
  onValueChange: (value: Readonly<Vars>) => void
}>

type Point = { x: number; y: number }
type Stroke = { pointerId: number; point: Point; changes: Vars; baseline: Readonly<Vars> }
const formatValue = (value: number) => new Intl.NumberFormat('ko-KR', { maximumSignificantDigits: 7 }).format(value)

export function VarsEditor(props: VarsEditorProps) {
  // A new document/schema must discard pending gestures and expanded tensor editors.
  return <VarsEditorContent key={JSON.stringify([props.resetKey, props.schema, props.disabled])} {...props} />
}

function VarsEditorContent({ schema, value, disabled = false, resetKey, onValueChange }: VarsEditorProps) {
  const bars = useRef(new Map<string, HTMLDivElement>())
  const stroke = useRef<Stroke | null>(null)
  const [preview, setPreview] = useState<Readonly<Vars> | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const tensorEditors = useRef(new Map<string, TensorEditorHandle>())
  const latestValue = useRef(value)
  const id = useId()
  const displayed = preview ?? value

  useLayoutEffect(() => {
    latestValue.current = value
    const active = stroke.current
    if (
      active &&
      Object.entries(schema).every(([key, entry]) => entry.shape.length > 0 || active.baseline[key] === value[key])
    ) {
      setPreview({ ...value, ...active.changes })
    } else {
      stroke.current = null
      setPreview(null)
    }
  }, [value, schema])

  const commitChanges = (changes: Readonly<Vars>) => {
    const next = { ...latestValue.current, ...changes }
    latestValue.current = next
    onValueChange(next)
  }

  const paint = (point: Point) => {
    const active = stroke.current
    if (!active) return
    const from = active.point
    const next = { ...active.changes }
    for (const [key, bar] of bars.current) {
      const entry = schema[key]
      if (entry.min === entry.max) continue
      const bounds = bar.getBoundingClientRect()
      if (bounds.width <= 0 || Math.max(from.y, point.y) < bounds.top || Math.min(from.y, point.y) > bounds.bottom)
        continue
      // Interpolate where the pointer path last intersects this row, even when events skip rows.
      const y = Math.max(bounds.top, Math.min(bounds.bottom, point.y))
      const fraction = point.y === from.y ? 1 : (y - from.y) / (point.y - from.y)
      const x = from.x + (point.x - from.x) * fraction
      const ratio = Math.max(0, Math.min(1, (x - bounds.left) / bounds.width))
      next[key] = entry.min + ratio * (entry.max - entry.min)
    }
    active.point = point
    active.changes = next
    setPreview({ ...latestValue.current, ...next })
  }

  const finish = (event: PointerEvent<HTMLDivElement>, cancel: boolean) => {
    const active = stroke.current
    if (!active || active.pointerId !== event.pointerId) return
    if (!cancel) paint({ x: event.clientX, y: event.clientY })
    stroke.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
    setPreview(null)
    if (!cancel && Object.keys(active.changes).some((key) => active.changes[key] !== latestValue.current[key]))
      commitChanges(active.changes)
  }

  return (
    <div className="min-w-0 space-y-3">
      <div
        className="space-y-3"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || stroke.current) return
          const target = (event.target as HTMLElement).closest<HTMLElement>('[data-scalar-key]')
          const key = target?.dataset.scalarKey
          if (key === undefined || schema[key].min === schema[key].max) return
          event.preventDefault()
          target?.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          const point = { x: event.clientX, y: event.clientY }
          stroke.current = { pointerId: event.pointerId, point, changes: {}, baseline: latestValue.current }
          paint(point)
        }}
        onPointerMove={(event) => {
          if (stroke.current?.pointerId === event.pointerId) paint({ x: event.clientX, y: event.clientY })
        }}
        onPointerUp={(event) => finish(event, false)}
        onPointerCancel={(event) => finish(event, true)}
        onLostPointerCapture={() => {
          stroke.current = null
          setPreview(null)
        }}
      >
        {Object.entries(schema).map(([key, entry], index) => {
          const tensor = entry.shape.length > 0
          const members = flattenVarsTensor(displayed[key], entry.shape, key)
          const current = members.reduce((mean, member) => mean + member / members.length, 0)
          const percent =
            entry.max === entry.min
              ? 100
              : Math.max(0, Math.min(100, ((current - entry.min) / (entry.max - entry.min)) * 100))
          const fixed = entry.min === entry.max
          const bar = (
            <>
              <span
                className="pointer-events-none absolute inset-y-0 left-0 bg-primary/65"
                style={{ width: `${percent}%` }}
              />
              <span
                className="pointer-events-none absolute inset-y-0 w-0.5 bg-primary"
                style={{ left: `clamp(0px, ${percent}%, calc(100% - 2px))` }}
              />
            </>
          )
          return (
            <div key={key} className="space-y-1">
              <div className="flex min-w-0 items-baseline justify-between gap-2 text-xs">
                <span className="truncate font-medium" title={key}>
                  {key}
                </span>
                <span className="shrink-0 font-mono" aria-label={`${key} ${tensor ? '평균' : '값'}`}>
                  {tensor ? '평균 ' : ''}
                  {formatValue(current)}
                </span>
              </div>
              {tensor ? (
                <button
                  type="button"
                  aria-label={`${key} tensor 편집`}
                  aria-expanded={expanded.has(key)}
                  aria-controls={`${id}-tensor-${index}`}
                  disabled={disabled}
                  className="relative block h-6 w-full overflow-hidden rounded border bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  onClick={() => {
                    if (expanded.has(key)) tensorEditors.current.get(key)?.flushPendingChanges()
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }}
                >
                  {bar}
                  {expanded.has(key) ? (
                    <ChevronDown
                      aria-hidden="true"
                      className="absolute top-1 right-1 size-4 rounded bg-background/80"
                    />
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className="absolute top-1 right-1 size-4 rounded bg-background/80"
                    />
                  )}
                </button>
              ) : (
                <div
                  role="slider"
                  aria-label={key}
                  aria-valuemin={entry.min}
                  aria-valuemax={entry.max}
                  aria-valuenow={current}
                  aria-disabled={disabled || fixed}
                  tabIndex={disabled || fixed ? -1 : 0}
                  data-scalar-key={key}
                  ref={(node) => {
                    if (node) bars.current.set(key, node)
                    else bars.current.delete(key)
                  }}
                  className="relative h-6 touch-none overflow-hidden rounded border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
                  onKeyDown={(event) => {
                    if (disabled || fixed || stroke.current) return
                    const step = (entry.max - entry.min) / 100
                    let next: number
                    if (event.key === 'Home') next = entry.min
                    else if (event.key === 'End') next = entry.max
                    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
                      next = Math.min(entry.max, current + step)
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
                      next = Math.max(entry.min, current - step)
                    else return
                    event.preventDefault()
                    if (next !== current) commitChanges({ [key]: next })
                  }}
                >
                  {bar}
                </div>
              )}
              <div className="flex justify-between gap-2 font-mono text-[10px] text-muted-foreground">
                <span>{formatValue(entry.min)}</span>
                {tensor ? <span>[{entry.shape.join(' × ')}]</span> : fixed ? <span>고정</span> : null}
                <span>{formatValue(entry.max)}</span>
              </div>
              {tensor && expanded.has(key) ? (
                <section
                  id={`${id}-tensor-${index}`}
                  aria-label={`${key} tensor 상세 편집`}
                  className="min-w-0 rounded border bg-muted/10 p-1.5"
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerMove={(event) => event.stopPropagation()}
                  onPointerUp={(event) => event.stopPropagation()}
                  onPointerCancel={(event) => event.stopPropagation()}
                  onLostPointerCapture={(event) => event.stopPropagation()}
                >
                  <TensorEditor
                    ref={(editor) => {
                      if (editor) tensorEditors.current.set(key, editor)
                      else tensorEditors.current.delete(key)
                    }}
                    compact
                    initialHeatmapMode="region-wheel"
                    label={key}
                    shape={entry.shape}
                    minimum={entry.min}
                    maximum={entry.max}
                    value={value[key]}
                    disabled={disabled}
                    selectionResetKey={resetKey}
                    onValueChange={(next) => commitChanges({ [key]: next })}
                  />
                </section>
              ) : null}
            </div>
          )
        })}
      </div>
      {Object.keys(schema).length === 0 ? (
        <p className="text-xs text-muted-foreground">정의된 vars가 없습니다.</p>
      ) : null}
    </div>
  )
}
