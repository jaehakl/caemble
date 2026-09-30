import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  const [search, setSearch] = useState('')
  const entries = Object.entries(schema).filter(([name]) => name.toLowerCase().includes(search.trim().toLowerCase()))
  return (
    <div className="space-y-3" aria-label="최적화 변수 범위">
      <p className="text-xs leading-relaxed text-muted-foreground">
        현재 값을 포함하는 범위를 입력하세요. 탐색을 해제한 값은 고정됩니다.
      </p>
      {Object.keys(schema).length > 8 ? (
        <Input
          aria-label="변수 검색"
          placeholder="변수 이름으로 검색"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      {!entries.length ? (
        <p className="py-3 text-center text-xs text-muted-foreground">일치하는 변수가 없습니다.</p>
      ) : null}
      <div className="max-h-96 space-y-3 overflow-auto pr-1">
        {entries.map(([name, entry]) => {
          const selected = axes.filter((axis) => axis.name === name)
          const values = flattenVarsTensor(variables[name], entry.shape, name)
          const fixed = selected.every((axis) => axis.fixed)
          const elementOffset = elementPages[name]
          const updateGroup = (change: Partial<OptimizationAxis>) =>
            onChange(axes.map((axis) => (axis.name === name ? { ...axis, ...change } : axis)))
          return (
            <fieldset className="min-w-0 rounded-lg border p-3 text-xs" key={name}>
              <legend className="max-w-full px-1 font-mono font-medium break-all">
                {name}
                {entry.shape.length ? ` [${entry.shape.join(' × ')}]` : ''}
              </legend>
              <div className="grid grid-cols-2 items-center gap-2">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    aria-label={`${name} 탐색`}
                    checked={!fixed}
                    disabled={entry.min === entry.max}
                    onChange={(event) => updateGroup({ fixed: !event.target.checked })}
                  />
                  탐색
                </label>
                {!entry.shape.length ? (
                  <span title={String(values[0])} className="truncate text-right font-mono text-muted-foreground">
                    현재 {Number(values[0].toPrecision(7))}
                  </span>
                ) : (
                  <span className="text-right text-muted-foreground">
                    {selected.filter((axis) => !axis.fixed).length} / {selected.length}개 탐색
                  </span>
                )}
                <label className="min-w-0 space-y-1">
                  하한
                  <Input
                    className="mt-1 h-8 w-full font-mono text-xs"
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
                <label className="min-w-0 space-y-1">
                  상한
                  <Input
                    className="mt-1 h-8 w-full font-mono text-xs"
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
                            <Input
                              className="h-8 w-24 font-mono text-xs"
                              type="number"
                              step="any"
                              aria-label={`${label} 하한`}
                              value={Number.isFinite(axis.min) ? axis.min : ''}
                              disabled={axis.fixed}
                              onChange={(event) => update({ min: event.target.valueAsNumber })}
                            />
                            <span>–</span>
                            <Input
                              className="h-8 w-24 font-mono text-xs"
                              type="number"
                              step="any"
                              aria-label={`${label} 상한`}
                              value={Number.isFinite(axis.max) ? axis.max : ''}
                              disabled={axis.fixed}
                              onChange={(event) => update({ max: event.target.valueAsNumber })}
                            />
                            <span className="font-mono text-muted-foreground">
                              {axis.fixed ? '고정' : '현재'}{' '}
                              {Number(values[(elementOffset ?? 0) + index].toPrecision(7))}
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
    </div>
  )
}
