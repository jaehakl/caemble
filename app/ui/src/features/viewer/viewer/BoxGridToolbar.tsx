import { useContext, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChartLine,
  Grid2X2,
  Box,
  LockKeyhole,
  Copy,
  ArrowLeftRight,
  ArrowUpDown,
  Play,
  Pause,
  Repeat,
  Activity,
  ArrowUpRight,
  Waves,
  Gauge,
} from 'lucide-react'
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
import {
  ViewerAxisIcon,
  ViewerOutputMenuHost,
  ViewerToolButton,
  ViewerToolPanelBody,
  ViewerSelectTool,
} from './ViewerTools'
import { plotColor } from './pointCloudData'

const labels = { x: 'x', y: 'y', z: 'z', time: 't', frequency: 'f', channel: '채널' }
const roleColors = {
  space: 'border-2 border-sky-500!',
  statistic: 'border-2 border-violet-500!',
  index: 'border-2 border-orange-500!',
}
type PanelAxis = ProjectionAxis | 'channel'

export function BoxGridToolbar(props: {
  leaf: CalculationInputLeaf
  mode?: 'space' | 'chart'
  kind: PlotKind
  axes: ProjectionAxis[]
  reduce: Partial<Record<ProjectionAxis, ProjectionReduction>>
  representation: 'amplitude' | 'phase'
  component: BoxGridComponentChoice
  onKind: (kind: PlotKind) => void
  onAxes: (axes: ProjectionAxis[]) => void
  onRole: (axis: ProjectionAxis, role: 'space' | ProjectionReduction['method']) => void
  onRepresentation: (representation: 'amplitude' | 'phase') => void
  onComponent: (component: BoxGridComponentChoice) => void
  onIndex: (axis: ProjectionAxis, index: number) => void
  fixed: readonly [number, number] | null
  range: readonly number[]
  onFixed: (range: [number, number] | null) => void
  wavelengthDisplay: boolean
  onWavelength: (wavelength: boolean) => void
  animation: BoxGridAnimation
  playing: boolean
  repeat: boolean
  speed: number
  timeSeconds: number
  durationSeconds: number
  oscillationError: string
  playbackError: string
  onPlay: (axis: Exclude<BoxGridAnimation, 'off'>) => void
  onPause: () => void
  onRepeat: (repeat: boolean) => void
  onSpeed: (speed: number) => void
  onTime: (time: number) => void
  onDuration: (duration: number) => void
  ready: boolean
  onCopy: () => Promise<void>
}) {
  const { leaf, axes, reduce, animation } = props
  const [panels, setPanels] = useState<Partial<Record<PanelAxis, 'role' | 'index'>>>(() => ({
    ...Object.fromEntries(
      projectionAxes
        .filter((axis) => !axes.includes(axis) && reduce[axis]?.method === 'index')
        .map((axis) => [axis, 'index']),
    ),
    ...(animation === 'oscillation' ? { channel: 'index' as const } : {}),
  }))
  const openAxis = (axis: PanelAxis, indexed: boolean) => {
    if (panels[axis]) {
      closeAxis(axis)
      return
    }
    setPanels((current) => ({ ...current, [axis]: indexed ? 'index' : 'role' }))
  }
  const closeAxis = (axis: PanelAxis) => {
    setPanels((current) => ({ ...current, [axis]: undefined }))
    if (animation === axis || (axis === 'channel' && animation === 'oscillation')) props.onPause()
  }
  const indexControls = (axis: ProjectionAxis) => {
    const position = projectionAxes.indexOf(axis)
    const index = reduce[axis]?.index ?? 0
    const length = leaf.shape[position]
    return (
      <>
        <input
          type="range"
          aria-label={`${axis} index`}
          min={0}
          max={length - 1}
          step={1}
          value={index}
          onChange={(event) => props.onIndex(axis, Number(event.target.value))}
        />
        <output className="font-mono break-words" aria-label={`${axis} 좌표`}>
          {index} · {String(leaf.axes[position].ticks[index] ?? '현재 데이터 범위 밖')} {leaf.axes[position].unit ?? ''}
        </output>
        <div className="flex items-center gap-1">
          <ViewerToolButton
            label={`${labels[axis]} ${props.playing && animation === axis ? '일시정지' : '재생'}`}
            active={props.playing && animation === axis}
            disabled={length < 2 || Boolean(props.playbackError)}
            title={
              props.playbackError || (length < 2 ? '표본이 하나여서 재생할 수 없습니다.' : `${labels[axis]} index 순회`)
            }
            onClick={() => props.onPlay(axis)}
          >
            {props.playing && animation === axis ? <Pause /> : <Play />}
          </ViewerToolButton>
          <ViewerToolButton label="반복" active={props.repeat} onClick={() => props.onRepeat(!props.repeat)}>
            <Repeat />
          </ViewerToolButton>
        </div>
      </>
    )
  }
  return (
    <>
      {props.mode !== 'chart' && props.mode !== 'space' ? (
        <div aria-label="시각화 도구모음" className="flex flex-col gap-1">
          {(
            [
              { kind: 'line', label: 'Line Chart', icon: ChartLine },
              { kind: 'heatmap', label: 'Heatmap', icon: Grid2X2 },
              { kind: 'cloud', label: '3D Point cloud', icon: Box },
            ] as const
          ).map(({ kind, label, icon: Icon }) => (
            <ViewerToolButton key={kind} label={label} active={props.kind === kind} onClick={() => props.onKind(kind)}>
              <Icon />
            </ViewerToolButton>
          ))}
        </div>
      ) : null}
      {props.mode === 'space' ? <p>{props.kind === 'cloud' ? 'XYZ · 3D Point cloud' : '공간 Heatmap'}</p> : null}
      {props.mode !== 'space' ? (
        <ComponentPicker
          leaf={leaf}
          component={props.component}
          representation={props.representation}
          onComponent={props.onComponent}
        />
      ) : null}
      {props.mode === 'chart' ? (
        <ChartAxesPicker
          kind={props.kind}
          axes={axes}
          leaf={leaf}
          reduce={reduce}
          onKind={props.onKind}
          onAxes={props.onAxes}
          onRole={props.onRole}
          onIndex={props.onIndex}
        />
      ) : null}
      {projectionAxes
        .filter((axis) => props.mode !== 'chart' && (props.mode !== 'space' || !['x', 'y', 'z'].includes(axis)))
        .map((axis) => {
          const reduction = reduce[axis]?.method ?? 'mean'
          const selected = axes.includes(axis)
          const role = selected ? 'space' : reduction === 'index' ? 'index' : 'statistic'
          const title = `${labels[axis]} · ${selected ? '공간축' : role === 'index' ? `개별 index ${reduce[axis]?.index ?? 0} · ${leaf.axes[projectionAxes.indexOf(axis)].ticks[reduce[axis]?.index ?? 0]} ${leaf.axes[projectionAxes.indexOf(axis)].unit ?? ''}` : reduction}`
          const options = (
            <>
              <option value="space" disabled={props.mode === 'space'}>
                공간축
              </option>
              {['mean', 'sum', 'min', 'max', 'median', 'std', 'index'].map((method) => (
                <option key={method} value={method}>
                  {method === 'index' ? '개별 index' : method}
                </option>
              ))}
            </>
          )
          const changeRole = (next: string) => {
            props.onRole(axis, next as 'space' | ProjectionReduction['method'])
            setPanels((current) => ({ ...current, [axis]: next === 'index' ? 'index' : undefined }))
          }
          return (
            <div key={axis} className="flex items-start gap-1">
              {role === 'index' ? (
                <ViewerToolButton
                  label={`${labels[axis]} 축 역할`}
                  title={title}
                  className={roleColors.index}
                  aria-expanded={Boolean(panels[axis])}
                  onClick={() => openAxis(axis, true)}
                >
                  <ViewerAxisIcon axis={labels[axis]} />
                </ViewerToolButton>
              ) : (
                <ViewerSelectTool
                  label={`${labels[axis]} 축 역할`}
                  aria-label={`${axis} 역할`}
                  title={title}
                  className={roleColors[role]}
                  icon={<ViewerAxisIcon axis={labels[axis]} />}
                  value={role === 'space' ? 'space' : reduction}
                  onChange={(event) => changeRole(event.target.value)}
                >
                  {options}
                </ViewerSelectTool>
              )}
              {role === 'index' && panels[axis] ? (
                <ViewerToolPanelBody label={`${labels[axis]} 축`} onClose={() => closeAxis(axis)}>
                  <select
                    aria-label={`${axis} 역할`}
                    value={reduction}
                    onChange={(event) => changeRole(event.target.value)}
                  >
                    {options}
                  </select>
                  {indexControls(axis)}
                </ViewerToolPanelBody>
              ) : null}
            </div>
          )
        })}
      <div className="flex items-start gap-1">
        {animation === 'oscillation' ? (
          <ViewerToolButton
            label="채널 축 역할"
            title="채널 · 시간 전개"
            className={roleColors.index}
            aria-expanded={Boolean(panels.channel)}
            onClick={() => openAxis('channel', true)}
          >
            <Waves />
          </ViewerToolButton>
        ) : (
          <ViewerSelectTool
            label="채널"
            icon={<Waves />}
            className={roleColors.index}
            value={props.representation}
            onChange={(event) => {
              if (event.target.value === 'oscillation') {
                props.onTime(0)
                setPanels((current) => ({ ...current, channel: 'index' }))
              } else props.onRepresentation(event.target.value as 'amplitude' | 'phase')
            }}
          >
            <option value="amplitude">{leaf.shape[5] === 2 ? 'Amplitude' : 'Value'}</option>
            {leaf.shape[5] === 2 ? <option value="phase">Phase (rad)</option> : null}
            <option value="oscillation" disabled={Boolean(props.oscillationError)}>
              시간 전개
            </option>
          </ViewerSelectTool>
        )}
        {animation === 'oscillation' && panels.channel ? (
          <ViewerToolPanelBody label="채널" onClose={() => closeAxis('channel')}>
            <select
              aria-label="채널"
              value="oscillation"
              onChange={(event) => {
                props.onRepresentation(event.target.value as 'amplitude' | 'phase')
                closeAxis('channel')
              }}
            >
              <option value="amplitude">Amplitude</option>
              <option value="phase">Phase (rad)</option>
              <option value="oscillation">시간 전개</option>
            </select>
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
            <output aria-label="Animation 시간" className="w-full font-mono tabular-nums">
              {props.timeSeconds.toExponential(5)} s
            </output>
            <div className="flex gap-1">
              <ViewerToolButton
                label={props.playing ? '시간 전개 일시정지' : '시간 전개 재생'}
                active={props.playing}
                title={props.oscillationError || 'A × cos(φ + 2πft) · 공통 시간 전개'}
                disabled={Boolean(props.oscillationError || props.playbackError)}
                onClick={() => props.onPlay('oscillation')}
              >
                {props.playing ? <Pause /> : <Play />}
              </ViewerToolButton>
              <ViewerToolButton label="반복" active={props.repeat} onClick={() => props.onRepeat(!props.repeat)}>
                <Repeat />
              </ViewerToolButton>
            </div>
            <label className="grid gap-1">
              재생 구간 (s)
              <input
                aria-label="재생 구간 (s)"
                type="number"
                min={0}
                step="any"
                value={props.durationSeconds}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isFinite(value) && value > 0) props.onDuration(value)
                }}
              />
            </label>
            {props.oscillationError ? <p>{props.oscillationError}</p> : null}
          </ViewerToolPanelBody>
        ) : null}
      </div>
      <BoxGridRangeControl fixed={props.fixed} range={props.range} onFixed={props.onFixed} />
      <ViewerSelectTool
        label="재생 속도"
        icon={<Gauge />}
        value={props.speed}
        onChange={(event) => props.onSpeed(Number(event.target.value))}
      >
        {[0.25, 0.5, 1, 2, 4].map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </ViewerSelectTool>
      {leaf.boxGrid.frequencyKind === 'source-sampled' ? (
        <ViewerSelectTool
          label="주파수 표시 단위"
          icon={<Activity />}
          value={props.wavelengthDisplay ? 'nm' : 'Hz'}
          onChange={(event) => props.onWavelength(event.target.value === 'nm')}
        >
          <option value="nm">nm</option>
          <option value="Hz">Hz</option>
        </ViewerSelectTool>
      ) : null}
      <ViewerToolButton label="변환 코드 복사" disabled={!props.ready} onClick={() => void props.onCopy()}>
        <Copy />
      </ViewerToolButton>
    </>
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
  const menuHost = useContext(ViewerOutputMenuHost)?.host
  const vector = boxGridVectorComponents(leaf)
  const tensor = boxGridTensorComponents(leaf)
  if (!menuHost) return null
  if (vector) {
    const choices = ['arrows', 'magnitudeSquared', 'x', 'y', 'z'] as const
    const selected =
      component === 'magnitude'
        ? 'arrows'
        : typeof component === 'number'
          ? (['x', 'y', 'z'] as const)[vector.indexOf(component)]
          : component
    return createPortal(
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
      </section>,
      menuHost,
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
    return createPortal(
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
      </section>,
      menuHost,
    )
  }
  return createPortal(
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
    </section>,
    menuHost,
  )
}

function ChartAxesPicker({
  kind,
  axes,
  leaf,
  reduce,
  onKind,
  onAxes,
  onRole,
  onIndex,
}: {
  kind: PlotKind
  axes: ProjectionAxis[]
  leaf: CalculationInputLeaf
  reduce: Partial<Record<ProjectionAxis, ProjectionReduction>>
  onKind: (kind: PlotKind) => void
  onAxes: (axes: ProjectionAxis[]) => void
  onRole: (axis: ProjectionAxis, role: ProjectionReduction['method']) => void
  onIndex: (axis: ProjectionAxis, index: number) => void
}) {
  const menuHost = useContext(ViewerOutputMenuHost)?.host
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
  if (!menuHost) return null
  return createPortal(
    <section aria-label="Box Grid 축 설정" className="w-[42rem] max-w-full pr-1">
      <div className="mb-3 flex gap-1" aria-label="차트 종류">
        <ViewerToolButton label="Line Chart" active={kind === 'line'} onClick={() => onKind('line')}>
          <ChartLine />
        </ViewerToolButton>
        <ViewerToolButton label="Heatmap" active={kind === 'heatmap'} onClick={() => onKind('heatmap')}>
          <Grid2X2 />
        </ViewerToolButton>
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
            </div>
          )
        })}
      </div>
    </section>,
    menuHost,
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
    <div className="flex items-start gap-1">
      <ViewerToolButton
        label="값 범위 고정"
        active={Boolean(fixed)}
        aria-expanded={Boolean(fixed)}
        onClick={() => {
          setDraft(null)
          onFixed(fixed ? null : [range[0], range[1]])
        }}
      >
        <LockKeyhole />
      </ViewerToolButton>
      {fixed ? (
        <ViewerToolPanelBody
          label="값 범위 고정"
          onClose={() => {
            setDraft(null)
            onFixed(null)
          }}
        >
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
        </ViewerToolPanelBody>
      ) : null}
    </div>
  )
}
