import { useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChartLine, Grid2X2, Box, LockKeyhole, ArrowLeftRight, ArrowUpDown, ArrowUpRight, Square } from 'lucide-react'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import {
  boxGridTensorComponents,
  projectionAxes,
  type ProjectionAxis,
  type ProjectionReduction,
} from '@/lib/calculation/boxGridProject'
import {
  boxGridVectorComponents,
  type BoxGridAnimation,
  type BoxGridComponentChoice,
  type PlotKind,
} from './boxGridViewData'
import { ViewerAxisIcon, ViewerOutputMenuHost, ViewerToolButton } from './ViewerTools'
import { plotColor } from './pointCloudData'

const labels = { x: 'x', y: 'y', z: 'z', time: 't', frequency: 'f' }

export function BoxGridOutputSettings(props: {
  leaf: CalculationInputLeaf
  mode?: 'space' | 'chart'
  kind: PlotKind
  squarePixels: boolean
  axes: ProjectionAxis[]
  reduce: Partial<Record<ProjectionAxis, ProjectionReduction>>
  representation: 'amplitude' | 'phase'
  component: BoxGridComponentChoice
  onKind: (kind: PlotKind) => void
  onSquarePixels: (value: boolean) => void
  onAxes: (axes: ProjectionAxis[]) => void
  onRole: (axis: ProjectionAxis, role: 'space' | ProjectionReduction['method']) => void
  onRepresentation: (representation: 'amplitude' | 'phase') => void
  onComponent: (component: BoxGridComponentChoice) => void
  onIndex: (axis: ProjectionAxis, index: number) => void
  fixed: readonly [number, number] | null
  range: readonly number[]
  onFixed: (range: [number, number] | null) => void
  wavelengthDisplay: boolean
  onWavelength: (value: boolean) => void
  animation: BoxGridAnimation
  timeSeconds: number
  durationSeconds: number
  oscillationError: string
  onTime: (time: number) => void
}) {
  const menuHost = useContext(ViewerOutputMenuHost)?.host
  if (!menuHost || props.mode === 'space') return null
  const { leaf } = props
  return createPortal(
    <div
      aria-label="Box Grid Output 설정"
      className="grid w-[42rem] max-w-full gap-3 pr-1 [&_input[type=number]]:w-28 [&_input[type=number]]:rounded [&_input[type=number]]:border [&_input[type=number]]:p-1 [&_select]:rounded [&_select]:border [&_select]:p-1"
    >
      {props.mode === 'chart' ? (
        <ChartAxesPicker {...props} />
      ) : (
        <section aria-label="Box Grid 축 설정" className="grid gap-2">
          <div aria-label="시각화 도구모음" className="flex gap-1">
            {(
              [
                { kind: 'line', label: 'Line Chart', icon: ChartLine },
                { kind: 'heatmap', label: 'Heatmap', icon: Grid2X2 },
                { kind: 'cloud', label: '3D Point cloud', icon: Box },
              ] as const
            ).map(({ kind, label, icon: Icon }) => (
              <ViewerToolButton
                key={kind}
                label={label}
                active={props.kind === kind}
                onClick={() => props.onKind(kind)}
              >
                <Icon />
              </ViewerToolButton>
            ))}
          </div>
          {projectionAxes.map((axis, position) => (
            <div key={axis} aria-label={`${labels[axis]} 축 설정`} className="flex items-center gap-2">
              <span className="w-6">{labels[axis]}</span>
              <select
                aria-label={`${axis} 역할`}
                value={props.axes.includes(axis) ? 'space' : (props.reduce[axis]?.method ?? 'mean')}
                onChange={(event) => props.onRole(axis, event.target.value as 'space' | ProjectionReduction['method'])}
              >
                <option value="space">공간축</option>
                {['mean', 'sum', 'min', 'max', 'median', 'std', 'index'].map((method) => (
                  <option key={method} value={method}>
                    {method === 'index' ? '개별 index' : method}
                  </option>
                ))}
              </select>
              {!props.axes.includes(axis) && props.reduce[axis]?.method === 'index' ? (
                <input
                  aria-label={`${axis} index`}
                  type="range"
                  min={0}
                  max={leaf.shape[position] - 1}
                  step={1}
                  value={props.reduce[axis]?.index ?? 0}
                  onChange={(event) => props.onIndex(axis, Number(event.target.value))}
                />
              ) : null}
              {axis === 'frequency' && leaf.boxGrid.frequencyKind === 'source-sampled' ? (
                <select
                  aria-label="주파수 표시 단위"
                  value={props.wavelengthDisplay ? 'nm' : 'Hz'}
                  onChange={(event) => props.onWavelength(event.target.value === 'nm')}
                >
                  <option value="nm">nm</option>
                  <option value="Hz">Hz</option>
                </select>
              ) : null}
            </div>
          ))}
        </section>
      )}
      <section aria-label="Amplitude/Phase 설정" className="grid gap-2">
        <label className="flex items-center gap-2">
          Amplitude/Phase
          <select
            aria-label="채널"
            value={props.animation === 'oscillation' ? 'oscillation' : props.representation}
            onChange={(event) => {
              if (event.target.value === 'oscillation') props.onTime(props.timeSeconds)
              else props.onRepresentation(event.target.value as 'amplitude' | 'phase')
            }}
          >
            <option value="amplitude">{leaf.shape[5] === 2 ? 'Amplitude' : 'Value'}</option>
            {leaf.shape[5] === 2 ? (
              <>
                <option value="phase">Phase (rad)</option>
                <option value="oscillation" disabled={Boolean(props.oscillationError)}>
                  시간 전개
                </option>
              </>
            ) : null}
          </select>
        </label>
        {props.animation === 'oscillation' ? (
          <>
            <input
              aria-label="Animation 프레임"
              type="range"
              min={0}
              max={props.durationSeconds}
              step="any"
              value={props.timeSeconds}
              disabled={Boolean(props.oscillationError)}
              onChange={(event) => props.onTime(Number(event.target.value))}
            />
            <label>
              순간값 시간 (s){' '}
              <input
                aria-label="순간값 시간 (s)"
                type="number"
                min={0}
                max={props.durationSeconds}
                step="any"
                value={props.timeSeconds}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (
                    event.target.value.trim() &&
                    Number.isFinite(value) &&
                    value >= 0 &&
                    value <= props.durationSeconds
                  )
                    props.onTime(value)
                }}
              />
            </label>
            <output aria-label="Animation 시간" className="font-mono tabular-nums">
              {props.timeSeconds.toExponential(5)} s
            </output>
            {props.oscillationError ? <p>{props.oscillationError}</p> : null}
          </>
        ) : null}
      </section>
      <ComponentPicker
        leaf={leaf}
        component={props.component}
        representation={props.animation === 'oscillation' ? 'amplitude' : props.representation}
        onComponent={props.onComponent}
      />
      <BoxGridRangeControl fixed={props.fixed} range={props.range} onFixed={props.onFixed} />
    </div>,
    menuHost,
  )
}

function ComponentPicker({
  leaf,
  component,
  representation,
  onComponent,
}: {
  leaf: CalculationInputLeaf
  component: BoxGridComponentChoice
  representation: 'amplitude' | 'phase'
  onComponent: (component: BoxGridComponentChoice) => void
}) {
  const vector = boxGridVectorComponents(leaf)
  const tensor = boxGridTensorComponents(leaf)
  if (vector) {
    const choices = ['arrows', 'magnitudeSquared', 'x', 'y', 'z'] as const
    const selected =
      component === 'magnitude'
        ? 'arrows'
        : typeof component === 'number'
          ? (['x', 'y', 'z'] as const)[vector.indexOf(component)]
          : component
    return (
      <section aria-label="Box Grid 성분 설정" className="mb-3">
        <p className="mb-1 font-medium">성분</p>
        <div className="flex gap-1">
          {choices.map((choice) => (
            <ViewerToolButton
              key={choice}
              label={`벡터 ${choice === 'arrows' ? '화살표 |V|' : choice === 'magnitudeSquared' ? '|V|²' : choice.toUpperCase()}`}
              active={selected === choice}
              disabled={representation === 'phase' && (choice === 'arrows' || choice === 'magnitudeSquared')}
              onClick={() =>
                onComponent(
                  choice === 'arrows' || choice === 'magnitudeSquared'
                    ? choice
                    : vector[['x', 'y', 'z'].indexOf(choice)],
                )
              }
            >
              {choice === 'arrows' ? (
                <ArrowUpRight />
              ) : choice === 'magnitudeSquared' ? (
                <span className="text-[10px]">|V|²</span>
              ) : (
                <span>{choice.toUpperCase()}</span>
              )}
            </ViewerToolButton>
          ))}
        </div>
      </section>
    )
  }
  if (tensor) {
    const choices = ['arrows', 'all', 'x', 'y', 'z'] as const
    const pair =
      typeof component === 'object'
        ? component.tensor
        : typeof component === 'number'
          ? (() => {
              for (let row = 0; row < 3; row++)
                for (let column = 0; column < 3; column++)
                  if (tensor[row][column] === component)
                    return [(['x', 'y', 'z'] as const)[row], (['x', 'y', 'z'] as const)[column]] as const
              return ['all', 'all'] as const
            })()
          : (['all', 'all'] as const)
    return (
      <section aria-label="Box Grid 성분 설정" className="mb-3">
        <p className="mb-1 font-medium">텐서 성분</p>
        {[0, 1].map((row) => (
          <div key={row} className="mb-1 flex items-center gap-1" aria-label={`텐서 ${row + 1}축 성분`}>
            <span className="w-8">{row + 1}축</span>
            {choices.map((choice) => (
              <ViewerToolButton
                key={choice}
                label={`텐서 ${row + 1}축 ${choice === 'arrows' ? '화살표' : choice === 'all' ? '|T|' : choice.toUpperCase()}`}
                active={pair[row] === choice}
                disabled={representation === 'phase' && (choice === 'arrows' || choice === 'all')}
                onClick={() => {
                  const next = [...pair] as ['x' | 'y' | 'z' | 'all' | 'arrows', 'x' | 'y' | 'z' | 'all' | 'arrows']
                  next[row] = choice
                  if (choice === 'arrows' && next[1 - row] === 'arrows') next[1 - row] = 'all'
                  onComponent({ tensor: next })
                }}
              >
                {choice === 'arrows' ? (
                  <ArrowUpRight />
                ) : choice === 'all' ? (
                  <span className="text-[10px]">|T|</span>
                ) : (
                  <span>{choice.toUpperCase()}</span>
                )}
              </ViewerToolButton>
            ))}
          </div>
        ))}
      </section>
    )
  }
  return (
    <section aria-label="Box Grid 성분 설정" className="mb-3">
      <label className="flex items-center gap-2">
        성분
        <select
          aria-label="성분"
          value={typeof component === 'number' ? component : 'magnitude'}
          onChange={(event) =>
            onComponent(event.target.value === 'magnitude' ? 'magnitude' : Number(event.target.value))
          }
        >
          <option value="magnitude" disabled={representation === 'phase'}>
            |V|
          </option>
          {leaf.boxGrid.components.map((label, index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </section>
  )
}

function ChartAxesPicker({
  kind,
  squarePixels,
  axes,
  leaf,
  reduce,
  onKind,
  onSquarePixels,
  onAxes,
  onRole,
  onIndex,
  wavelengthDisplay,
  onWavelength,
}: {
  wavelengthDisplay: boolean
  onWavelength: (value: boolean) => void
  kind: PlotKind
  squarePixels: boolean
  axes: ProjectionAxis[]
  leaf: CalculationInputLeaf
  reduce: Partial<Record<ProjectionAxis, ProjectionReduction>>
  onKind: (kind: PlotKind) => void
  onSquarePixels: (value: boolean) => void
  onAxes: (axes: ProjectionAxis[]) => void
  onRole: (axis: ProjectionAxis, role: ProjectionReduction['method']) => void
  onIndex: (axis: ProjectionAxis, index: number) => void
}) {
  const primary = axes[axes.length - 1]
  const secondary = axes.length > 1 ? axes[0] : null
  const select = (axis: ProjectionAxis, row: 'primary' | 'secondary') => {
    if (row === 'primary') {
      if (axis !== primary) onAxes(axis === secondary ? [primary, axis] : secondary ? [secondary, axis] : [axis])
      return
    }
    if (axis === secondary) {
      if (kind === 'line') onAxes([primary])
    } else if (axis === primary) {
      if (secondary) onAxes([primary, secondary])
    } else onAxes([axis, primary])
  }
  return (
    <section aria-label="Box Grid 축 설정" className="w-[42rem] max-w-full pr-1">
      <div className="mb-3 flex flex-wrap items-center gap-1" aria-label="차트 종류">
        <ViewerToolButton label="Line Chart" active={kind === 'line'} onClick={() => onKind('line')}>
          <ChartLine />
        </ViewerToolButton>
        <ViewerToolButton label="Heatmap" active={kind === 'heatmap'} onClick={() => onKind('heatmap')}>
          <Grid2X2 />
        </ViewerToolButton>
        <ViewerToolButton
          label="정사각 픽셀"
          title={`정사각 픽셀 · ${squarePixels ? '켜짐' : '꺼짐'}`}
          active={kind === 'heatmap' && squarePixels}
          disabled={kind !== 'heatmap'}
          onClick={() => onSquarePixels(!squarePixels)}
        >
          <Square />
        </ViewerToolButton>
        <output
          aria-label="BoxGrid shape (x, y, z, time, frequency, amplitudePhase, component)"
          className="ml-auto min-w-0 text-right font-mono text-slate-600 tabular-nums"
        >
          Shape: {leaf.shape.join(' × ')}
        </output>
      </div>
      <div className="grid gap-2">
        {projectionAxes.map((axis) => {
          const selected = axes.includes(axis)
          const reduction = reduce[axis]?.method ?? 'mean'
          const index = reduce[axis]?.index ?? 0
          return (
            <div key={axis} className="flex min-w-max items-center gap-2" aria-label={`${labels[axis]} 축 설정`}>
              <span className="flex w-6 shrink-0 justify-center">
                <ViewerAxisIcon axis={labels[axis]} />
              </span>
              <ViewerToolButton
                label={`${labels[axis]} 주 축`}
                active={primary === axis}
                onClick={() => select(axis, 'primary')}
              >
                <ArrowLeftRight />
              </ViewerToolButton>
              <ViewerToolButton
                label={`${labels[axis]} 보조축`}
                active={secondary === axis}
                onClick={() => select(axis, 'secondary')}
              >
                <ArrowUpDown />
              </ViewerToolButton>
              {!selected ? (
                <>
                  <select
                    aria-label={`${axis} 적분 방법`}
                    value={reduction}
                    onChange={(event) => onRole(axis, event.target.value as ProjectionReduction['method'])}
                    className="h-8 rounded border border-slate-300 bg-white px-2 text-xs"
                  >
                    {['mean', 'sum', 'min', 'max', 'median', 'std', 'index'].map((method) => (
                      <option key={method} value={method}>
                        {method === 'index' ? '개별 index' : method}
                      </option>
                    ))}
                  </select>
                  {reduction === 'index' ? (
                    <input
                      type="range"
                      aria-label={`${axis} index`}
                      min={0}
                      max={leaf.shape[projectionAxes.indexOf(axis)] - 1}
                      step={1}
                      value={index}
                      onChange={(event) => onIndex(axis, Number(event.target.value))}
                      className="min-w-32 flex-1"
                    />
                  ) : null}
                </>
              ) : null}
              {axis === 'frequency' && leaf.boxGrid.frequencyKind === 'source-sampled' ? (
                <select
                  aria-label="주파수 표시 단위"
                  value={wavelengthDisplay ? 'nm' : 'Hz'}
                  onChange={(event) => onWavelength(event.target.value === 'nm')}
                >
                  <option value="nm">nm</option>
                  <option value="Hz">Hz</option>
                </select>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function BoxGridRangeControl({
  fixed,
  range,
  onFixed,
}: {
  fixed: readonly [number, number] | null
  range: readonly number[]
  onFixed: (range: [number, number] | null) => void
}) {
  const [draft, setDraft] = useState<[string, string] | null>(null)
  const invalid =
    draft !== null &&
    (draft.some((value) => value.trim() === '' || !Number.isFinite(Number(value))) ||
      Number(draft[0]) > Number(draft[1]))
  const gradient = [0, 0.5, 1]
    .map(
      (value) =>
        `rgb(${plotColor(value, [0, 1])
          .slice(0, 3)
          .map((channel) => Math.round(channel * 255))
          .join(',')})`,
    )
    .join(',')
  return (
    <section aria-label="값 범위" className="grid gap-2">
      <p className="font-medium">값 범위</p>
      <ViewerToolButton
        label="값 범위 고정"
        active={Boolean(fixed)}
        onClick={() => {
          setDraft(null)
          onFixed(fixed ? null : [range[0], range[1]])
        }}
      >
        <LockKeyhole />
      </ViewerToolButton>
      <span>{fixed ? '고정' : `자동 · ${range[0]} ~ ${range[1]}`}</span>
      {fixed ? (
        <div className="grid gap-1">
          <div className="flex items-center gap-1">
            {[0, 1].map((end) => (
              <span key={end} className="contents">
                {end === 1 ? (
                  <span
                    aria-label="값 colorbar"
                    className="h-3 min-w-10 flex-1"
                    style={{ background: `linear-gradient(to right, ${gradient})` }}
                  />
                ) : null}
                <input
                  className="w-20"
                  aria-label={end ? '범위 최댓값' : '범위 최솟값'}
                  aria-invalid={invalid}
                  type="number"
                  step="any"
                  value={draft?.[end] ?? fixed[end]}
                  onChange={(event) => {
                    const next: [string, string] = draft ? [...draft] : [String(fixed[0]), String(fixed[1])]
                    next[end] = event.target.value
                    setDraft(next)
                    if (
                      next.every((value) => value.trim() !== '' && Number.isFinite(Number(value))) &&
                      Number(next[0]) <= Number(next[1])
                    )
                      onFixed([Number(next[0]), Number(next[1])])
                  }}
                />
              </span>
            ))}
          </div>
          {invalid ? <p role="alert">유한한 최솟값 ≤ 최댓값을 입력하세요. 마지막 유효 범위를 표시합니다.</p> : null}
        </div>
      ) : null}
    </section>
  )
}
