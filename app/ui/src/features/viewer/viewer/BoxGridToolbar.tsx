import { useState } from 'react'
import {
  BarChart3,
  ChartLine,
  Grid2X2,
  Box,
  Layers,
  Blend,
  LockKeyhole,
  Copy,
  SlidersHorizontal,
  Play,
  Pause,
  Repeat,
  Activity,
  Component,
  Waves,
  Gauge,
} from 'lucide-react'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import { projectionAxes, type ProjectionAxis, type ProjectionReduction } from '@/lib/calculation/boxGridProject'
import type { BoxGridAnimation, PlotKind } from './boxGridViewData'
import { ViewerAxisIcon, ViewerToolButton, ViewerToolPanel, ViewerToolPanelBody, ViewerSelectTool } from './ViewerTools'
import { plotColor } from './pointCloudData'

const labels = { x: 'x', y: 'y', z: 'z', time: 't', frequency: 'f', component: 'comp', channel: '채널' }
const roleColors = {
  space: 'border-2 border-sky-500!',
  statistic: 'border-2 border-violet-500!',
  index: 'border-2 border-orange-500!',
}
type ComponentChoice = number | 'magnitude' | 'arrows'
type IndexAxis = ProjectionAxis | 'component'
type PanelAxis = IndexAxis | 'channel'

export function BoxGridToolbar(props: {
  leaf: CalculationInputLeaf
  kind: PlotKind
  axes: ProjectionAxis[]
  reduce: Partial<Record<ProjectionAxis, ProjectionReduction>>
  representation: 'amplitude' | 'phase'
  component: ComponentChoice
  arrowsAllowed: boolean
  onKind: (kind: PlotKind) => void
  onRole: (axis: ProjectionAxis, role: 'space' | ProjectionReduction['method']) => void
  onRepresentation: (representation: 'amplitude' | 'phase') => void
  onComponent: (component: ComponentChoice) => void
  onIndex: (axis: IndexAxis, index: number) => void
  overlay: boolean
  geometryOpacity: number
  overlayAvailable: boolean
  geometryBlockedReason?: string
  onOverlay: () => void
  onOpacity: (opacity: number) => void
  fixed: readonly [number, number] | null
  range: readonly number[]
  onFixed: (range: [number, number] | null) => void
  bins?: number
  onBins: (bins: number | undefined) => void
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
  const indexControls = (axis: IndexAxis) => {
    const position = axis === 'component' ? 6 : projectionAxes.indexOf(axis)
    const index = axis === 'component' ? Number(props.component) : (reduce[axis]?.index ?? 0)
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
      <div aria-label="시각화 도구모음" className="flex flex-col gap-1">
        {(
          [
            { kind: 'histogram', label: 'Histogram', icon: BarChart3 },
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
      <ViewerToolButton
        label="Geometry 겹치기"
        active={props.overlay && props.overlayAvailable}
        disabled={!props.overlayAvailable}
        title={
          !props.overlayAvailable
            ? (props.geometryBlockedReason ?? '현재 시각화에서는 Geometry를 겹칠 수 없습니다.')
            : 'Geometry 겹치기'
        }
        onClick={props.onOverlay}
      >
        <Layers />
      </ViewerToolButton>
      <ViewerToolPanel label="Geometry 투명도" icon={<Blend />}>
        <input
          aria-label="Geometry 투명도"
          type="range"
          min={0.05}
          max={1}
          step={0.05}
          disabled={!props.overlayAvailable || !props.overlay}
          value={props.geometryOpacity}
          onChange={(event) => props.onOpacity(Number(event.target.value))}
        />
        <output>{Math.round(props.geometryOpacity * 100)}%</output>
      </ViewerToolPanel>
      {projectionAxes.map((axis) => {
        const reduction = reduce[axis]?.method ?? 'mean'
        const role = axes.includes(axis) ? 'space' : reduction === 'index' ? 'index' : 'statistic'
        const title = `${labels[axis]} · ${role === 'space' ? '공간축' : role === 'index' ? `개별 index ${reduce[axis]?.index ?? 0} · ${leaf.axes[projectionAxes.indexOf(axis)].ticks[reduce[axis]?.index ?? 0]} ${leaf.axes[projectionAxes.indexOf(axis)].unit ?? ''}` : reduction}`
        const options = (
          <>
            <option value="space" disabled={axes.length >= 3 && role !== 'space'}>
              공간축{axes.length >= 3 && role !== 'space' ? ' · 최대 3개' : ''}
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
      <div className="flex items-start gap-1">
        {typeof props.component === 'number' ? (
          <ViewerToolButton
            label="comp 축 역할"
            title={`comp · 개별 index ${props.component}`}
            className={roleColors.index}
            aria-expanded={Boolean(panels.component)}
            onClick={() => openAxis('component', true)}
          >
            <Component />
          </ViewerToolButton>
        ) : (
          <ViewerSelectTool
            label="성분"
            icon={<Component />}
            title={`comp · ${props.component}`}
            className={roleColors.statistic}
            value={props.component}
            onChange={(event) => {
              const value = event.target.value
              props.onComponent(value === 'magnitude' || value === 'arrows' ? value : Number(value))
              if (value !== 'magnitude' && value !== 'arrows')
                setPanels((current) => ({ ...current, component: 'index' }))
            }}
          >
            <option value="magnitude" disabled={props.representation === 'phase'}>
              절대값 · 벡터 크기
            </option>
            {leaf.boxGrid.components.map((label, index) => (
              <option key={label} value={index}>
                {label}
              </option>
            ))}
            <option value="arrows" disabled={!props.arrowsAllowed}>
              화살표 (XYZ 벡터 전용)
            </option>
          </ViewerSelectTool>
        )}
        {typeof props.component === 'number' && panels.component ? (
          <ViewerToolPanelBody label="comp 축" onClose={() => closeAxis('component')}>
            <select
              aria-label="성분"
              value={props.component}
              onChange={(event) => {
                const value = event.target.value
                props.onComponent(value === 'magnitude' || value === 'arrows' ? value : Number(value))
                if (value === 'magnitude' || value === 'arrows') closeAxis('component')
              }}
            >
              <option value="magnitude" disabled={props.representation === 'phase'}>
                절대값 · 벡터 크기
              </option>
              {leaf.boxGrid.components.map((label, index) => (
                <option key={label} value={index}>
                  {label}
                </option>
              ))}
              <option value="arrows" disabled={!props.arrowsAllowed}>
                화살표 (XYZ 벡터 전용)
              </option>
            </select>
            {indexControls('component')}
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
      {props.kind === 'histogram' ? (
        <ViewerToolPanel label="Histogram bins" icon={<SlidersHorizontal />}>
          <input
            aria-label="Histogram bins"
            type="number"
            min={1}
            max={100}
            placeholder="자동"
            value={props.bins ?? ''}
            onChange={(event) =>
              props.onBins(
                event.target.value ? Math.max(1, Math.min(100, Math.trunc(Number(event.target.value)))) : undefined,
              )
            }
          />
        </ViewerToolPanel>
      ) : null}
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
