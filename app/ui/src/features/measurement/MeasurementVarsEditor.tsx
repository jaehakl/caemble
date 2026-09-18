import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Tensor, Vars } from '@/lib/cad/model/types'
import type { VarsSchema } from '@/lib/cad/model/vars'
import { flattenVarsTensor, varsTensorFromFlat } from '@/lib/cad/model/tensor'
import { MeasurementSplit } from './MeasurementSplit'

export type TensorOperation = 'fill' | 'add' | 'multiply'

export function editTensorValues(
  values: readonly number[],
  selected: readonly number[],
  operation: TensorOperation,
  operand: number,
  min: number,
  max: number,
): number[] {
  if (!Number.isFinite(operand)) throw new Error('유한한 숫자를 입력하세요.')
  const next = [...values]
  for (const index of selected) {
    const value =
      operation === 'fill' ? operand : operation === 'add' ? values[index] + operand : values[index] * operand
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`결과가 범위 [${min}, ${max}]를 벗어납니다. 변경하지 않았습니다.`)
    next[index] = value
  }
  return next
}

const fieldClass =
  'h-8 min-w-0 rounded border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring disabled:opacity-50'
const buttonClass = 'rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50'

export function MeasurementVarsEditor({
  schema,
  vars,
  selectedKey,
  onSelectedKeyChange,
  onVarsChange,
  onValidityChange,
  disabled = false,
  layout = 'horizontal',
  editorControls,
}: {
  schema: VarsSchema | null
  vars: Readonly<Vars> | null
  selectedKey: string | null
  onSelectedKeyChange: (key: string) => void
  onVarsChange: (vars: Vars) => void
  onValidityChange: (valid: boolean) => void
  disabled?: boolean
  layout?: 'horizontal' | 'vertical'
  editorControls?: ReactNode
}) {
  const keys = Object.keys(schema ?? {})
  const activeKey = selectedKey && keys.includes(selectedKey) ? selectedKey : keys[0]
  const entry = schema?.[activeKey]
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const dragging = useRef(false)
  const [slice, setSlice] = useState<number[]>([])
  const [scope, setScope] = useState<'all' | 'selected'>('all')
  const [operation, setOperation] = useState<TensorOperation>('fill')
  const [operand, setOperand] = useState('0')
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 500, height: 260 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const selectionKey = `${activeKey}:${JSON.stringify(entry?.shape)}`
  const values = useMemo(
    () => (entry && vars?.[activeKey] !== undefined ? flattenVarsTensor(vars[activeKey], entry.shape, activeKey) : []),
    [entry, vars, activeKey],
  )
  const previousValues = useRef(vars)
  const previousSelection = useRef(selectionKey)

  useEffect(() => {
    if (previousValues.current !== vars || previousSelection.current !== selectionKey) {
      setDrafts({})
      draftsRef.current = {}
      setError('')
      if (previousSelection.current !== selectionKey) {
        setSelected(new Set())
        setSlice([])
        anchor.current = null
      }
      previousValues.current = vars
      previousSelection.current = selectionKey
    }
  }, [vars, selectionKey])
  useEffect(() => {
    onValidityChange(Object.keys(drafts).length === 0 && !error)
  }, [drafts, error, onValidityChange])
  useEffect(() => {
    const stop = () => {
      dragging.current = false
    }
    window.addEventListener('pointerup', stop)
    return () => window.removeEventListener('pointerup', stop)
  }, [])
  useLayoutEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const update = () =>
      setViewport({
        left: element.scrollLeft,
        top: element.scrollTop,
        width: element.clientWidth || 500,
        height: element.clientHeight || 260,
      })
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [selectionKey])

  const commit = useCallback(() => {
    if (!entry || !vars || disabled) return false
    const pending = Object.entries(draftsRef.current)
    if (!pending.length) return true
    const next = [...values]
    for (const [index, text] of pending) {
      const value = Number(text)
      if (!text.trim() || !Number.isFinite(value) || value < entry.min || value > entry.max) {
        setError(`${activeKey}[${index}]: ${entry.min} 이상 ${entry.max} 이하의 유한한 숫자를 입력하세요.`)
        return false
      }
      next[Number(index)] = value
    }
    draftsRef.current = {}
    setDrafts({})
    setError('')
    onVarsChange({ ...vars, [activeKey]: varsTensorFromFlat(next, entry.shape) })
    return true
  }, [activeKey, disabled, entry, onVarsChange, values, vars])

  if (!schema || !vars || !entry)
    return (
      <div className="grid h-full place-items-center p-4 text-sm text-muted-foreground">
        {schema && !keys.length ? 'varsSchema에 항목이 없습니다.' : '평가된 Vars가 없습니다.'}
      </div>
    )
  const rank = entry.shape.length
  const columns = rank < 2 ? Math.max(1, values.length) : entry.shape[rank - 1]
  const rows = rank < 2 ? 1 : entry.shape[rank - 2]
  const sliceSize = rows * columns
  const sliceIndex = entry.shape
    .slice(0, -2)
    .reduce((index, length, dimension) => index * length + Math.min(length - 1, slice[dimension] ?? 0), 0)
  const offset = rank > 2 ? sliceIndex * sliceSize : 0
  const cellWidth = rank < 2 ? 108 : 112
  const cellHeight = rank < 2 ? 250 : 68
  const firstColumn = Math.max(0, Math.floor(viewport.left / cellWidth) - 1)
  const lastColumn = Math.min(columns, Math.ceil((viewport.left + viewport.width) / cellWidth) + 1)
  const firstRow = Math.max(0, Math.floor(viewport.top / cellHeight) - 1)
  const lastRow = Math.min(rows, Math.ceil((viewport.top + viewport.height) / cellHeight) + 1)
  const locked = disabled || entry.min === entry.max
  const targetIndexes = scope === 'all' ? values.map((_, index) => index) : [...selected]

  const selectRange = (index: number, additive = false, extend = false) => {
    const start = extend && anchor.current !== null ? anchor.current : index
    const next = additive ? new Set(selected) : new Set<number>()
    if (rank < 2) {
      for (let n = Math.min(start, index); n <= Math.max(start, index); n++) next.add(n)
    } else {
      const startRow = Math.floor((start - offset) / columns),
        endRow = Math.floor((index - offset) / columns)
      const startColumn = (start - offset) % columns,
        endColumn = (index - offset) % columns
      for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row++)
        for (let col = Math.min(startColumn, endColumn); col <= Math.max(startColumn, endColumn); col++)
          next.add(offset + row * columns + col)
    }
    if (additive && !extend && selected.has(index)) next.delete(index)
    if (!extend) anchor.current = index
    setSelected(next)
  }
  const cells = []
  for (let row = firstRow; row < lastRow; row++)
    for (let col = firstColumn; col < lastColumn; col++) {
      const index = offset + row * columns + col
      const label =
        rank === 0
          ? activeKey
          : `${activeKey}[${
              rank > 2
                ? `${entry.shape
                    .slice(0, -2)
                    .map((_, dimension) => slice[dimension] ?? 0)
                    .join(',')},`
                : ''
            }${rank < 2 ? col : `${row},${col}`}]`
      cells.push(
        <div
          key={index}
          className={`absolute flex flex-col gap-1 rounded border p-1 ${selected.has(index) ? 'border-primary bg-primary/10' : 'bg-card'}`}
          style={{ left: col * cellWidth, top: row * cellHeight, width: cellWidth - 4, height: cellHeight - 4 }}
          onPointerEnter={(event) => {
            if (dragging.current && event.buttons === 1) selectRange(index, false, true)
          }}
        >
          {rank ? (
            <button
              type="button"
              aria-label={`${label} 선택`}
              aria-pressed={selected.has(index)}
              className="truncate text-left text-[10px] text-muted-foreground"
              onPointerDown={(event) => {
                if (event.button !== 0 || !commit()) return
                dragging.current = true
                selectRange(index, event.ctrlKey || event.metaKey, event.shiftKey)
              }}
              onClick={(event) => {
                if (event.detail === 0 && commit()) selectRange(index, event.ctrlKey || event.metaKey, event.shiftKey)
              }}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault()
                  selectRange(index, event.ctrlKey || event.metaKey, event.shiftKey)
                  return
                }
                const delta =
                  event.key === 'ArrowRight'
                    ? 1
                    : event.key === 'ArrowLeft'
                      ? -1
                      : event.key === 'ArrowDown'
                        ? columns
                        : event.key === 'ArrowUp'
                          ? -columns
                          : 0
                if (!delta) return
                event.preventDefault()
                const next = Math.max(offset, Math.min(offset + sliceSize - 1, index + delta))
                selectRange(next, false, event.shiftKey)
                const nextRow = Math.floor((next - offset) / columns),
                  nextColumn = (next - offset) % columns
                viewportRef.current?.scrollTo({
                  left: Math.max(0, nextColumn * cellWidth - viewport.width / 2),
                  top: Math.max(0, nextRow * cellHeight - viewport.height / 2),
                })
                requestAnimationFrame(() =>
                  viewportRef.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus(),
                )
              }}
              data-cell={index}
            >
              {rank < 2 ? `[${col}]` : `[${row}, ${col}]`}
            </button>
          ) : null}
          <input
            aria-label={label}
            aria-invalid={drafts[index] !== undefined && Boolean(error)}
            className={fieldClass}
            type="text"
            inputMode="decimal"
            disabled={locked}
            value={drafts[index] ?? String(values[index])}
            title={`${label} · [${entry.min}, ${entry.max}]`}
            onChange={(event) => {
              const next = { ...draftsRef.current, [index]: event.target.value }
              draftsRef.current = next
              setDrafts(next)
              setError('')
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                const next = { ...draftsRef.current }
                delete next[index]
                draftsRef.current = next
                setDrafts(next)
                setError('')
              }
            }}
          />
          {rank < 2 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center text-[10px] text-muted-foreground">
              <span>{entry.max}</span>
              <input
                aria-label={`${label} 슬라이더`}
                aria-orientation="vertical"
                aria-valuetext={String(values[index])}
                type="range"
                min={0}
                max={1000}
                step={1}
                className="min-h-0 w-7 flex-1 accent-primary"
                style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                disabled={locked || Object.keys(drafts).length > 0}
                value={entry.max === entry.min ? 0 : ((values[index] - entry.min) / (entry.max - entry.min)) * 1000}
                onChange={(event) => {
                  const next = [...values]
                  next[index] = entry.min + (Number(event.target.value) / 1000) * (entry.max - entry.min)
                  onVarsChange({ ...vars, [activeKey]: varsTensorFromFlat(next, entry.shape) })
                }}
              />
              <span>{entry.min}</span>
            </div>
          ) : null}
        </div>,
      )
    }

  const list = (
    <div
      className="grid max-h-full auto-rows-[88px] gap-2 overflow-y-auto p-2"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(120px, 100%), 1fr))' }}
    >
      {keys.map((key) => {
        const item = schema[key]
        const flat = flattenVarsTensor(vars[key] as Tensor, item.shape, key)
        const average = flat.length ? flat.reduce((sum, value) => sum + value / flat.length, 0) : null
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={activeKey === key}
            aria-label={`Var ${key}`}
            title={key}
            className={`flex h-[88px] min-w-0 flex-col justify-center gap-1 rounded border p-2 text-left text-xs ${activeKey === key ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent'}`}
            onClick={() => {
              if (commit()) onSelectedKeyChange(key)
            }}
          >
            <strong className="w-full truncate">{key}</strong>
            {item.shape.length ? (
              <>
                <span className="truncate">shape [{item.shape.join(' × ')}]</span>
                <span className="truncate">
                  평균 {average === null ? '—' : average.toLocaleString('ko-KR', { maximumSignificantDigits: 7 })}
                </span>
              </>
            ) : (
              <span className="truncate">{String(vars[key])}</span>
            )}
          </button>
        )
      })}
    </div>
  )
  const editor = (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <header className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
        <strong className="truncate" title={activeKey}>
          {activeKey}
        </strong>
        <span className="text-muted-foreground">
          [{entry.min}, {entry.max}]
        </span>
      </header>
      {editorControls}
      {rank > 2 ? (
        <div className="flex shrink-0 flex-wrap gap-2">
          {entry.shape.slice(0, -2).map((length, dimension) => (
            <label key={dimension} className="text-xs">
              축 {dimension}
              <input
                aria-label={`${activeKey} 축 ${dimension} 단면`}
                type="number"
                className={`${fieldClass} ml-1 w-16`}
                min={0}
                max={length - 1}
                step={1}
                value={slice[dimension] ?? 0}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (!Number.isInteger(value) || value < 0 || value >= length || !commit()) return
                  setSlice((current) =>
                    entry.shape.slice(0, -2).map((_, index) => (index === dimension ? value : (current[index] ?? 0))),
                  )
                  setSelected(new Set())
                  anchor.current = null
                }}
              />
            </label>
          ))}
        </div>
      ) : null}
      {rank ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <select
            aria-label="일괄 편집 대상"
            className={fieldClass}
            value={scope}
            onChange={(event) => setScope(event.target.value as 'all' | 'selected')}
          >
            <option value="all">전체 tensor ({values.length})</option>
            <option value="selected">선택 ({selected.size})</option>
          </select>
          <select
            aria-label="일괄 연산"
            className={fieldClass}
            value={operation}
            onChange={(event) => setOperation(event.target.value as TensorOperation)}
          >
            <option value="fill">채우기</option>
            <option value="add">더하기</option>
            <option value="multiply">곱하기</option>
          </select>
          <input
            aria-label="일괄 편집 값"
            className={`${fieldClass} w-20`}
            value={operand}
            onChange={(event) => setOperand(event.target.value)}
          />
          <button
            type="button"
            className={buttonClass}
            disabled={locked || !targetIndexes.length || Object.keys(drafts).length > 0}
            onClick={() => {
              try {
                if (!operand.trim()) throw new Error('숫자를 입력하세요.')
                const next = editTensorValues(values, targetIndexes, operation, Number(operand), entry.min, entry.max)
                setError('')
                onVarsChange({ ...vars, [activeKey]: varsTensorFromFlat(next, entry.shape) })
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause))
              }
            }}
          >
            적용 {targetIndexes.length}개
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={locked || !values.length || Object.keys(drafts).length > 0}
            title="이 tensor 전체의 값을 범위 내에서 새로 생성합니다."
            onClick={() => {
              setError('')
              onVarsChange({
                ...vars,
                [activeKey]: varsTensorFromFlat(
                  values.map(() => entry.min + Math.random() * (entry.max - entry.min)),
                  entry.shape,
                ),
              })
            }}
          >
            Shuffle · 전체
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {values.length ? (
        <div
          ref={viewportRef}
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(event) => {
            const { scrollLeft: left, scrollTop: top } = event.currentTarget
            setViewport((current) => ({ ...current, left, top }))
          }}
        >
          <div className="relative" style={{ width: columns * cellWidth, height: rows * cellHeight }}>
            {cells}
          </div>
        </div>
      ) : (
        <div className="grid min-h-20 flex-1 place-items-center text-xs text-muted-foreground">
          원소가 없는 tensor입니다.
        </div>
      )}
    </div>
  )
  return (
    <section aria-label="Measurement Vars 편집기" className="flex h-full min-h-0 flex-col">
      <MeasurementSplit
        vertical={layout === 'vertical'}
        initial={layout === 'vertical' ? 0.6 : 0.4}
        label={layout === 'vertical' ? 'Vars 값 편집과 항목 높이 조절' : 'Vars 항목과 값 편집 너비 조절'}
        first={layout === 'vertical' ? editor : list}
        second={layout === 'vertical' ? list : editor}
      />
    </section>
  )
}
