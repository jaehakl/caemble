import { Layers, Waves } from 'lucide-react'
import { ViewerAxisIcon, ViewerLayout, ViewerToolPanel, ViewerSelectTool } from './ViewerTools'
import { useViewerComparison, useViewerSetting, ViewerControls } from './comparisonSettings'
import { useMemo } from 'react'
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
  const comparison = useViewerComparison()
  const members = rules.filter((rule) => rule.label === name || rule.label.startsWith(`${name}.`))
  const preferred = contract.visualization.valuePath ? `${name}.${contract.visualization.valuePath}` : name
  const [representation, setRepresentation] = useViewerSetting('tensor.representation', 'abs')
  const [member, setMember] = useViewerSetting('tensor.member', preferred, 'item', (value) =>
    members.some((rule) => rule.label === value),
  )
  const rule = members.find((item) => item.label === member) ?? (comparison ? undefined : members[0])
  const value = rule && data?.[rule.label]
  const shape = isDataTensor(value) ? value.shape : []
  const [indices, setIndices] = useViewerSetting<Record<number, number>>('tensor.indices', {}, 'item', (value) =>
    Object.entries(value).every(([axis, index]) => index < (shape[Number(axis)] ?? 0)),
  )
  const [axes, setAxes] = useViewerSetting<readonly number[] | null>(
    'tensor.axes',
    null,
    'item',
    (value) => value === null || value.every((axis) => axis < shape.length),
  )
  const result = useMemo(() => {
    try {
      if (!rule || !isDataTensor(value)) return { error: '기록된 데이터가 없습니다.' }
      const accessor = createDataTensorAccessor(rule.result, value)
      const rank = accessor.shape.length
      const displayAxes =
        axes ?? (contract.visualization.spatialAxes ?? Array.from({ length: rank }, (_, i) => i)).slice(-2)
      const selected = displayAxes.filter((axis) => axis >= 0 && axis < rank)
      if (
        comparison &&
        (selected.length !== displayAxes.length ||
          accessor.shape.some(
            (length, axis) =>
              !selected.includes(axis) &&
              (!Number.isInteger(indices[axis] ?? 0) || (indices[axis] ?? 0) < 0 || (indices[axis] ?? 0) >= length),
          ))
      )
        return {
          accessor,
          selected: displayAxes,
          error: '저장된 축·인덱스 설정을 현재 데이터 shape에 적용할 수 없습니다. 공통 툴바에서 수정하세요.',
        }
      const shape = selected.map((axis) => accessor.shape[axis])
      if (accessor.shape.some((length) => length === 0)) return { error: '빈 결과입니다.' }
      const count = shape.reduce((a, b) => a * b, 1)
      const sliced = Array.from({ length: count }, (_, flat) => {
        const position = accessor.shape.map((length, axis) =>
          comparison ? (indices[axis] ?? 0) : Math.min(indices[axis] ?? 0, Math.max(0, length - 1)),
        )
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
          boxGrid: undefined,
          axes: selected.map((axis) => rule.result.axes?.[axis] ?? { name: `component ${axis}` }),
        },
      }
      const tensor = {
        ...accessor.tensor,
        boxGrid: undefined,
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
  }, [rule, value, axes, indices, contract, representation, comparison])
  return (
    <ViewerLayout>
      <div className="h-full overflow-auto p-3" data-result-visualization={contract.visualization.kind}>
        {contract.visualization.kind === 'bundle' ? (
          <p className="mb-3 text-xs text-slate-500">
            구성 데이터의 상세 보기입니다. 구조 변형 재생에는 mesh와 전체 절점의 시간 이력이 연결된 결과가 필요합니다.
          </p>
        ) : null}
        <ViewerControls>
          <div className="flex flex-col gap-1 text-xs">
            {rule?.result.dtype === 'complex64' ? (
              <ViewerSelectTool
                label="복소수 표현"
                icon={<Waves />}
                value={representation}
                onChange={(event) => setRepresentation(event.target.value)}
              >
                <option value="abs">진폭</option>
                <option value="re">실수부</option>
                <option value="im">허수부</option>
                <option value="arg">위상 (rad)</option>
              </ViewerSelectTool>
            ) : null}
            {members.length > 1 ? (
              <ViewerSelectTool
                label="구성 데이터"
                icon={<Layers />}
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
              </ViewerSelectTool>
            ) : null}
            {result.accessor?.shape.map((length, axis) => {
              const name = rule?.result.axes?.[axis]?.name ?? `Axis ${axis}`
              const selected = result.selected?.includes(axis) ?? false
              const changeRole = (role: string) =>
                setAxes(
                  role === 'space'
                    ? [...(result.selected ?? []).slice(-1), axis].sort((a, b) => a - b)
                    : (result.selected ?? []).filter((item) => item !== axis),
                )
              const options = (
                <>
                  <option value="space">공간축</option>
                  <option value="index">개별 index</option>
                </>
              )
              return selected ? (
                <ViewerSelectTool
                  key={axis}
                  label={`${name} 축`}
                  aria-label={`표시 축 ${axis}`}
                  title={`${name} · 공간축`}
                  className="border-2 border-sky-500!"
                  icon={<ViewerAxisIcon axis={name} />}
                  value="space"
                  onChange={(event) => changeRole(event.target.value)}
                >
                  {options}
                </ViewerSelectTool>
              ) : (
                <ViewerToolPanel key={axis} label={`${name} 축`} icon={<ViewerAxisIcon axis={name} />} initialOpen>
                  <select
                    aria-label={`표시 축 ${axis}`}
                    value="index"
                    onChange={(event) => changeRole(event.target.value)}
                  >
                    {options}
                  </select>
                  <input
                    aria-label={`축 ${axis} index`}
                    type="range"
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
                  <output className="font-mono break-words">
                    {indices[axis] ?? 0} ·{' '}
                    {String(result.accessor?.tensor.axes?.[axis]?.ticks?.[indices[axis] ?? 0] ?? indices[axis] ?? 0)}{' '}
                    {rule?.result.axes?.[axis]?.unit ?? ''}
                  </output>
                </ViewerToolPanel>
              )
            })}
          </div>
        </ViewerControls>
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
    </ViewerLayout>
  )
}
