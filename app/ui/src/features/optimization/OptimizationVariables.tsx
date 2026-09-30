import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { OptimizationAxis } from '@/contracts/api/optimization'
import { flattenVarsTensor, type Vars } from '@/lib/cad/model'
import type { VarsSchema } from '@/lib/cad/model/vars'

export function OptimizationVariables({
  schema,
  variables,
  axes,
  onChange,
}: {
  schema: VarsSchema
  variables: Readonly<Vars>
  axes: readonly OptimizationAxis[]
  onChange: (axes: OptimizationAxis[]) => void
}) {
  const [elementPages, setElementPages] = useState<Record<string, number | undefined>>({})
  return (
    <div className="space-y-2" aria-label="최적화 변수 범위">
      {Object.entries(schema).map(([name, entry]) => {
        const selected = axes.filter((axis) => axis.name === name)
        const values = flattenVarsTensor(variables[name], entry.shape, name)
        const fixed = selected.every((axis) => axis.fixed)
        const elementOffset = elementPages[name]
        const updateGroup = (change: Partial<OptimizationAxis>) =>
          onChange(axes.map((axis) => (axis.name === name ? { ...axis, ...change } : axis)))
        return (
          <fieldset className="rounded border p-2 text-xs" key={name}>
            <legend className="px-1 font-medium">
              {name}
              {entry.shape.length ? ` [${entry.shape.join(' × ')}]` : ''}
            </legend>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!fixed}
                  disabled={entry.min === entry.max}
                  onChange={(event) => updateGroup({ fixed: !event.target.checked })}
                />
                탐색
              </label>
              <label className="flex items-center gap-1">
                하한
                <input
                  className="w-24 rounded border bg-background px-1 py-1"
                  type="number"
                  step="any"
                  aria-label={`${name} 전체 하한`}
                  value={
                    Number.isFinite(selected[0]?.min) && selected.every((axis) => axis.min === selected[0].min)
                      ? selected[0].min
                      : ''
                  }
                  placeholder="개별 범위"
                  disabled={fixed}
                  onChange={(event) => updateGroup({ min: event.target.valueAsNumber })}
                />
              </label>
              <label className="flex items-center gap-1">
                상한
                <input
                  className="w-24 rounded border bg-background px-1 py-1"
                  type="number"
                  step="any"
                  aria-label={`${name} 전체 상한`}
                  value={
                    Number.isFinite(selected[0]?.max) && selected.every((axis) => axis.max === selected[0].max)
                      ? selected[0].max
                      : ''
                  }
                  placeholder="개별 범위"
                  disabled={fixed}
                  onChange={(event) => updateGroup({ max: event.target.valueAsNumber })}
                />
              </label>
              {!entry.shape.length ? (
                <span className="font-mono text-muted-foreground">현재 {values[0]}</span>
              ) : (
                <span className="text-muted-foreground">
                  {selected.filter((axis) => !axis.fixed).length} / {selected.length}개 탐색
                </span>
              )}
            </div>
            {entry.shape.length > 0 ? (
              <details
                className="mt-2"
                onToggle={(event) => {
                  const open = event.currentTarget.open
                  setElementPages((pages) => ({ ...pages, [name]: open ? 0 : undefined }))
                }}
              >
                <summary className="cursor-pointer text-muted-foreground">원소별 범위·고정</summary>
                <div className="mt-2 max-h-60 space-y-1 overflow-auto">
                  {(elementOffset === undefined ? [] : selected.slice(elementOffset, elementOffset + 100)).map(
                    (axis, index) => {
                      const label = `${name}${axis.indices.map((member) => `[${member}]`).join('')}`
                      const update = (change: Partial<OptimizationAxis>) =>
                        onChange(axes.map((current) => (current === axis ? { ...axis, ...change } : current)))
                      return (
                        <div className="flex flex-wrap items-center gap-2" key={label}>
                          <label className="flex min-w-24 items-center gap-1 font-mono">
                            <input
                              type="checkbox"
                              checked={!axis.fixed}
                              disabled={entry.min === entry.max}
                              aria-label={`${label} 탐색`}
                              onChange={(event) => update({ fixed: !event.target.checked })}
                            />
                            [{axis.indices.join(', ')}]
                          </label>
                          <input
                            className="w-24 rounded border bg-background px-1 py-1"
                            type="number"
                            step="any"
                            aria-label={`${label} 하한`}
                            value={Number.isFinite(axis.min) ? axis.min : ''}
                            disabled={axis.fixed}
                            onChange={(event) => update({ min: event.target.valueAsNumber })}
                          />
                          <span>–</span>
                          <input
                            className="w-24 rounded border bg-background px-1 py-1"
                            type="number"
                            step="any"
                            aria-label={`${label} 상한`}
                            value={Number.isFinite(axis.max) ? axis.max : ''}
                            disabled={axis.fixed}
                            onChange={(event) => update({ max: event.target.valueAsNumber })}
                          />
                          <span className="font-mono text-muted-foreground">
                            {axis.fixed ? '고정' : '현재'} {values[(elementOffset ?? 0) + index]}
                          </span>
                        </div>
                      )
                    },
                  )}
                </div>
                {elementOffset !== undefined && selected.length > 100 ? (
                  <div className="mt-2 flex items-center justify-between">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={elementOffset === 0}
                      onClick={() =>
                        setElementPages((pages) => ({ ...pages, [name]: Math.max(0, elementOffset - 100) }))
                      }
                    >
                      이전 원소
                    </Button>
                    <span>
                      {elementOffset + 1}–{Math.min(elementOffset + 100, selected.length)} / {selected.length}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={elementOffset + 100 >= selected.length}
                      onClick={() => setElementPages((pages) => ({ ...pages, [name]: elementOffset + 100 }))}
                    >
                      다음 원소
                    </Button>
                  </div>
                ) : null}
              </details>
            ) : null}
          </fieldset>
        )
      })}
    </div>
  )
}
