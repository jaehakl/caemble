import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
import { Button } from '@/components/ui/button'

function boundAtPath(bound: Tensor, path: readonly number[]) {
  return path.reduce<Tensor>((current, index) => (Array.isArray(current) ? current[index] : current), bound) as number
}

function updateTensor(tensor: Tensor, path: readonly number[], value: number): Tensor {
  if (path.length === 0) return value
  if (!Array.isArray(tensor)) return tensor
  const [index, ...rest] = path
  return tensor.map((item, itemIndex) => (itemIndex === index ? updateTensor(item, rest, value) : item))
}

function pathLabel(name: string, path: readonly number[]) {
  return `${name}${path.map((index) => `[${index}]`).join('')}`
}

export function VarsControls({
  disabled,
  overridden,
  schema,
  variables,
  onChange,
  onReset,
}: {
  disabled: boolean
  overridden: boolean
  schema: Readonly<Record<string, VarsSchemaEntry>> | null
  variables: Readonly<Vars> | null
  onChange: (variables: Readonly<Vars>) => void
  onReset: () => void
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setDrafts({})
    setErrors({})
  }, [schema, variables])

  if (!schema || !variables) {
    return (
      <div className="grid h-full place-items-center bg-slate-50 px-6 text-center">
        <div>
          <p className="text-sm font-semibold text-slate-700">Vars를 준비할 수 없습니다.</p>
          <p className="mt-1 text-xs text-slate-500">Structure 평가가 완료되면 조절할 수 있습니다.</p>
        </div>
      </div>
    )
  }

  const entries = Object.entries(schema)
  if (entries.length === 0) {
    return (
      <div className="grid h-full place-items-center bg-slate-50 px-6 text-center">
        <div>
          <p className="text-sm font-semibold text-slate-700">정의된 Vars가 없습니다.</p>
          <p className="mt-1 text-xs text-slate-500">Structure Source의 varsSchema에 변수를 추가하세요.</p>
        </div>
      </div>
    )
  }

  const updateValue = (name: string, path: readonly number[], value: number) => {
    const current = variables[name]
    if (current === undefined) return
    onChange(Object.freeze({ ...variables, [name]: updateTensor(current, path, value) }))
  }

  const renderNumber = (name: string, value: number, entry: VarsSchemaEntry, path: readonly number[]) => {
    const label = pathLabel(name, path)
    const minimum = boundAtPath(entry.min, path)
    const maximum = boundAtPath(entry.max, path)
    const fixed = minimum === maximum
    const error = errors[label]

    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3" key={label}>
        <div className="flex items-center justify-between gap-3">
          <label className="truncate font-mono text-xs font-medium text-slate-700" htmlFor={`${label}-number`}>
            {path.length === 0 ? 'value' : path.map((index) => `[${index}]`).join('')}
          </label>
          <span className="shrink-0 text-[11px] text-slate-500">
            {minimum} – {maximum}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_7.5rem] items-center gap-3">
          <input
            aria-label={`${label} 슬라이더`}
            className="h-2 w-full cursor-pointer accent-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled || fixed}
            max={maximum}
            min={minimum}
            step="any"
            type="range"
            value={value}
            onChange={(event) => updateValue(name, path, event.currentTarget.valueAsNumber)}
          />
          <input
            aria-describedby={error ? `${label}-error` : undefined}
            aria-invalid={Boolean(error)}
            aria-label={`${label} 숫자 입력`}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-right font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:bg-slate-100 disabled:text-slate-500"
            disabled={disabled || fixed}
            id={`${label}-number`}
            max={maximum}
            min={minimum}
            step="any"
            type="number"
            value={drafts[label] ?? String(value)}
            onChange={(event) => {
              const raw = event.currentTarget.value
              const nextValue = event.currentTarget.valueAsNumber
              setDrafts((current) => ({ ...current, [label]: raw }))
              if (!Number.isFinite(nextValue)) {
                setErrors((current) => ({ ...current, [label]: '유효한 숫자를 입력하세요.' }))
                return
              }
              if (nextValue < minimum || nextValue > maximum) {
                setErrors((current) => ({ ...current, [label]: `${minimum} 이상 ${maximum} 이하로 입력하세요.` }))
                return
              }
              setErrors((current) => {
                const next = { ...current }
                delete next[label]
                return next
              })
              updateValue(name, path, nextValue)
            }}
          />
        </div>
        {error ? (
          <p className="mt-2 text-xs text-rose-600" id={`${label}-error`} role="alert">
            {error}
          </p>
        ) : fixed ? (
          <p className="mt-2 text-[11px] text-slate-500">고정값</p>
        ) : null}
      </div>
    )
  }

  const renderTensor = (name: string, tensor: Tensor, entry: VarsSchemaEntry, path: readonly number[] = []) => {
    if (typeof tensor === 'number') return renderNumber(name, tensor, entry, path)
    const containsTensor = tensor.some(Array.isArray)
    return (
      <div
        className={
          containsTensor
            ? 'grid gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3'
            : 'grid gap-3 sm:grid-cols-2'
        }
        key={pathLabel(name, path)}
      >
        {containsTensor && path.length > 0 ? (
          <p className="font-mono text-xs font-semibold text-slate-500">{path.map((index) => `[${index}]`).join('')}</p>
        ) : null}
        {tensor.map((item, index) => renderTensor(name, item, entry, [...path, index]))}
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <div>
          <p className="text-sm font-semibold text-slate-800">Structure Vars</p>
          <p className="mt-0.5 text-xs text-slate-500">변경하면 Viewer가 자동으로 다시 평가됩니다.</p>
        </div>
        <Button disabled={!overridden || disabled} size="sm" variant="outline" onClick={onReset}>
          <RotateCcw /> 자동값 복원
        </Button>
      </div>
      {disabled ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          변경된 Source가 준비되면 Vars를 다시 조절할 수 있습니다.
        </div>
      ) : null}
      <div className="grid gap-4 p-4">
        {entries.map(([name, entry]) => (
          <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" key={name}>
            <div className="mb-3">
              <h3 className="font-mono text-sm font-semibold break-all text-slate-900">{name}</h3>
              <p className="mt-1 text-xs text-slate-500">min/max 범위 안에서 값을 조절합니다.</p>
            </div>
            {variables[name] === undefined ? (
              <p className="text-xs text-rose-600">평가 결과에 이 변수가 없습니다.</p>
            ) : (
              renderTensor(name, variables[name], entry)
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
