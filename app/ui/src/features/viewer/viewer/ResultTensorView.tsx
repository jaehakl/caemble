import { useMemo, useState } from 'react'
import type { RecordedResultContract } from '@/contracts/results'
import type { RecordedData, RecordedDataRule } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import RecordedDataResults from './RecordedDataResults'

export function ResultTensorView({
  name,
  contract,
  rules,
  data,
}: {
  name: string
  contract: RecordedResultContract
  rules: readonly RecordedDataRule[]
  data?: RecordedData | null
}) {
  const members = rules.filter((rule) => rule.label === name || rule.label.startsWith(`${name}.`))
  const preferred = contract.visualization.valuePath ? `${name}.${contract.visualization.valuePath}` : name
  const [representation, setRepresentation] = useState('abs')
  const [member, setMember] = useState(preferred)
  const rule = members.find((item) => item.label === member) ?? members[0]
  const [indices, setIndices] = useState<Record<number, number>>({})
  const [axes, setAxes] = useState<readonly number[] | null>(null)
  const value = rule && data?.[rule.label]
  const result = useMemo(() => {
    try {
      if (!rule || !isDataTensor(value)) return { error: '기록된 데이터가 없습니다.' }
      const accessor = createDataTensorAccessor(rule.result, value)
      const rank = accessor.shape.length
      const displayAxes =
        axes ?? (contract.visualization.spatialAxes ?? Array.from({ length: rank }, (_, i) => i)).slice(-2)
      const selected = displayAxes.filter((axis) => axis >= 0 && axis < rank)
      const shape = selected.map((axis) => accessor.shape[axis])
      if (accessor.shape.some((length) => length === 0)) return { error: '빈 결과입니다.' }
      const count = shape.reduce((a, b) => a * b, 1)
      const sliced = Array.from({ length: count }, (_, flat) => {
        const position = accessor.shape.map((length, axis) => Math.min(indices[axis] ?? 0, Math.max(0, length - 1)))
        for (let dimension = selected.length - 1; dimension >= 0; dimension--) {
          position[selected[dimension]] = flat % shape[dimension]
          flat = Math.floor(flat / shape[dimension])
        }
        const value = accessor.get(position)
        if (typeof value !== 'object') return value
        if (representation === 're') return value.re
        if (representation === 'im') return value.im
        if (representation === 'arg') {
          if (value.re === 0 && value.im === 0)
            throw new Error('진폭 0인 표본의 위상은 미정의입니다. 다른 표현을 선택하세요.')
          return Math.atan2(value.im, value.re)
        }
        return Math.hypot(value.re, value.im)
      })
      const tensorAxes = selected.map(
        (axis) => accessor.tensor.axes?.[axis] ?? { ticks: Array.from({ length: accessor.shape[axis] }, (_, i) => i) },
      )
      // Components selected by index are scalar samples of the original physical quantity.
      const slicedRule = {
        ...rule,
        result: {
          ...(rule.result.dtype === 'complex64'
            ? {
                ...rule.result,
                dtype: 'float32' as const,
                ...(representation === 'arg' ? { unit: 'rad' as const, quantityKind: 'PlaneAngle' } : {}),
              }
            : rule.result),
          tensorOrder: 0,
          axes: selected.map((axis) => rule.result.axes?.[axis] ?? { name: `component ${axis}` }),
        },
      }
      const tensor = {
        ...accessor.tensor,
        shape,
        axes: tensorAxes,
        storage: {
          kind: 'inline' as const,
          value:
            shape.length === 2
              ? Array.from({ length: shape[0] }, (_, row) => sliced.slice(row * shape[1], (row + 1) * shape[1]))
              : shape.length
                ? sliced
                : sliced[0],
        },
      }
      return { accessor, selected, rule: slicedRule, tensor, error: null }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [rule, value, axes, indices, contract, representation])
  return (
    <div className="h-full overflow-auto p-3" data-result-visualization={contract.visualization.kind}>
      {contract.visualization.kind === 'bundle' ? (
        <p className="mb-3 text-xs text-slate-500">
          구성 데이터의 상세 보기입니다. 구조 변형 재생에는 mesh와 전체 절점의 시간 이력이 연결된 결과가 필요합니다.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {rule?.result.dtype === 'complex64' ? (
          <label>
            복소수 표현{' '}
            <select value={representation} onChange={(event) => setRepresentation(event.target.value)}>
              <option value="abs">진폭</option>
              <option value="re">실수부</option>
              <option value="im">허수부</option>
              <option value="arg">위상 (rad)</option>
            </select>
          </label>
        ) : null}
        {members.length > 1 ? (
          <label>
            데이터{' '}
            <select
              aria-label="결과 구성 데이터"
              value={rule?.label ?? ''}
              onChange={(event) => {
                setMember(event.target.value)
                setIndices({})
                setAxes(null)
              }}
            >
              {members.map((item) => (
                <option key={item.label} value={item.label}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {result.accessor?.shape.map((length, axis) => (
          <label key={axis}>
            {rule.result.axes?.[axis]?.name ?? `Axis ${axis}`}{' '}
            <input
              aria-label={`표시 축 ${axis}`}
              type="checkbox"
              checked={result.selected?.includes(axis) ?? false}
              onChange={(event) =>
                setAxes(
                  event.target.checked
                    ? [...(result.selected ?? []).slice(-1), axis].sort((a, b) => a - b)
                    : (result.selected ?? []).filter((item) => item !== axis),
                )
              }
            />
            {!result.selected?.includes(axis) ? (
              <input
                className="w-20 rounded border"
                aria-label={`축 ${axis} index`}
                type="number"
                min={0}
                max={Math.max(0, length - 1)}
                value={indices[axis] ?? 0}
                onChange={(event) =>
                  setIndices({
                    ...indices,
                    [axis]: Math.min(length - 1, Math.max(0, Math.trunc(Number(event.target.value) || 0))),
                  })
                }
              />
            ) : null}
          </label>
        ))}
      </div>
      {result.error ? (
        <p role="alert">{result.error}</p>
      ) : result.rule && result.tensor ? (
        <RecordedDataResults
          quantityKinds={new Map()}
          rules={[result.rule]}
          recordedData={{ [result.rule.label]: result.tensor }}
        />
      ) : null}
    </div>
  )
}
