import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import { TensorEditor } from '@/components/tensor-editor'
import { Badge } from '@/components/ui/badge'
import { flattenVarsTensor, type Tensor, type Vars, type VarsSchemaEntry } from '@/lib/cad/model'

type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export function VarsPanel({
  candidateSessionKey,
  expandFirstByDefault = false,
  disabled,
  schema,
  samplingRanges,
  resetValues,
  vars,
  onSamplingRangeChange,
  onVariableChange,
}: {
  candidateSessionKey: string
  expandFirstByDefault?: boolean
  disabled: boolean
  schema: VarsSchema | null
  samplingRanges?: Readonly<Record<string, Readonly<{ min: number; max: number }>>>
  resetValues?: Readonly<Record<string, Tensor | undefined>>
  vars: Readonly<Vars> | null
  onSamplingRangeChange?: (key: string, range: Readonly<{ min: number; max: number }>) => void
  onVariableChange: (key: string, value: Tensor) => void
}) {
  const schemaKey = useMemo(
    () =>
      schema
        ? JSON.stringify(Object.entries(schema).map(([key, entry]) => [key, entry.shape, entry.min, entry.max]))
        : 'none',
    [schema],
  )
  const defaultExpandedKey = useMemo(
    () =>
      expandFirstByDefault && schema && vars
        ? (Object.keys(schema).find((key) => vars[key] !== undefined) ?? null)
        : null,
    [expandFirstByDefault, schema, vars],
  )
  const [selectedKey, setSelectedKey] = useState<string | null>(defaultExpandedKey)
  const previousSessionRef = useRef(candidateSessionKey)
  const previousSchemaRef = useRef(schemaKey)
  const previousDefaultExpandedKeyRef = useRef(defaultExpandedKey)
  useEffect(() => {
    const contextChanged = previousSessionRef.current !== candidateSessionKey || previousSchemaRef.current !== schemaKey
    if (
      contextChanged ||
      (expandFirstByDefault && previousDefaultExpandedKeyRef.current === null && defaultExpandedKey !== null)
    ) {
      setSelectedKey(defaultExpandedKey)
    }
    previousSessionRef.current = candidateSessionKey
    previousSchemaRef.current = schemaKey
    previousDefaultExpandedKeyRef.current = defaultExpandedKey
  }, [candidateSessionKey, defaultExpandedKey, expandFirstByDefault, schemaKey])

  const entry = selectedKey && schema ? schema[selectedKey] : undefined
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded border">
      {!schema || !vars ? (
        <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
          {disabled ? <LoaderCircle className="size-4 animate-spin" /> : '평가된 Candidate가 없습니다.'}
        </div>
      ) : Object.keys(schema).length ? (
        <div className="grid gap-2 p-2">
          {Object.entries(schema).map(([key, item]) => {
            const value = vars[key]
            const expanded = selectedKey === key && value !== undefined
            const values = value === undefined ? [] : flattenVarsTensor(value, item.shape, key)
            const minimum = values.reduce((current, member) => Math.min(current, member), Number.POSITIVE_INFINITY)
            const maximum = values.reduce((current, member) => Math.max(current, member), Number.NEGATIVE_INFINITY)
            return (
              <article className="overflow-hidden rounded border bg-card" key={key}>
                <button
                  aria-expanded={expanded}
                  className="flex w-full items-start gap-2 px-2 py-2 text-left text-xs transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={disabled || value === undefined}
                  type="button"
                  onClick={() => setSelectedKey((current) => (current === key ? null : key))}
                >
                  {expanded ? (
                    <ChevronDown className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono font-medium">{key}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-muted-foreground">
                      <Badge>{item.shape.length === 0 ? 'scalar' : JSON.stringify(item.shape)}</Badge>
                      <span>
                        schema [{item.min}, {item.max}]
                      </span>
                      {values.length ? (
                        <span className="font-mono">
                          {values.length === 1 ? String(values[0]) : `${values.length} cells · ${minimum}–${maximum}`}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
                {expanded && entry ? (
                  <div className="grid gap-2 border-t p-2">
                    {samplingRanges?.[key] && onSamplingRangeChange ? (
                      <div className="grid grid-cols-2 gap-2 rounded border bg-muted/30 p-2">
                        <label className="grid gap-1 text-[11px] text-muted-foreground">
                          Sampling Min
                          <input
                            className="h-8 rounded border bg-background px-2 font-mono text-xs text-foreground"
                            disabled={disabled}
                            max={samplingRanges[key].max}
                            min={item.min}
                            type="number"
                            value={samplingRanges[key].min}
                            onChange={(event) => {
                              const next = event.currentTarget.valueAsNumber
                              if (Number.isFinite(next))
                                onSamplingRangeChange(key, { ...samplingRanges[key], min: next })
                            }}
                          />
                        </label>
                        <label className="grid gap-1 text-[11px] text-muted-foreground">
                          Sampling Max
                          <input
                            className="h-8 rounded border bg-background px-2 font-mono text-xs text-foreground"
                            disabled={disabled}
                            max={item.max}
                            min={samplingRanges[key].min}
                            type="number"
                            value={samplingRanges[key].max}
                            onChange={(event) => {
                              const next = event.currentTarget.valueAsNumber
                              if (Number.isFinite(next))
                                onSamplingRangeChange(key, { ...samplingRanges[key], max: next })
                            }}
                          />
                        </label>
                      </div>
                    ) : null}
                    <TensorEditor
                      disabled={disabled}
                      key={`${candidateSessionKey}:${schemaKey}:${key}`}
                      label={key}
                      maximum={item.max}
                      minimum={item.min}
                      resetValue={resetValues?.[key]}
                      selectionResetKey={`${candidateSessionKey}:${schemaKey}:${key}`}
                      shape={item.shape}
                      value={value}
                      onValueChange={(next) => onVariableChange(key, next)}
                    />
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      ) : (
        <div className="grid h-full min-h-24 place-items-center p-3 text-center text-xs text-muted-foreground">
          varsSchema 항목이 없습니다.
        </div>
      )}
    </div>
  )
}
