import { useComparisonBusy, useViewerComparison, useViewerSetting, ViewerControls } from './comparisonSettings'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { RecordedData, RecordedDataRule, UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import {
  projectionAxes,
  projectionCode,
  type BoxGridProjectionOptions,
  type ProjectionAxis,
  type ProjectionReduction,
} from '@/lib/calculation/boxGridProject'
import { boxGridVectorComponents, type calculateBoxGridView } from './boxGridViewData'
import { createPointCloudData } from './pointCloudData'
import { ScalarPlot } from './ScalarPlot'
import { PlotProbe } from './PointCloudPlot'
import JscadViewer from './JscadViewer'
import type { HeatmapRenderData } from './structuredField'

type PlotKind = 'histogram' | 'line' | 'heatmap' | 'cloud'
const noLayers = Object.freeze([])
const axisLabels = { x: 'x', y: 'y', z: 'z', time: 't', frequency: 'f' }
export function BoxGridResult({
  name,
  rules,
  data,
  displayUnit,
  renderViewer,
  canOverlayGeometry,
  geometryBlockedReason,
  recordReference,
}: {
  name: string
  rules: readonly RecordedDataRule[]
  data?: RecordedData
  displayUnit: UcumUnit
  renderViewer: (data: HeatmapRenderData, geometryOpacity: number) => ReactNode
  canOverlayGeometry: boolean
  geometryBlockedReason?: string
  recordReference?: string
}) {
  const parsed = useMemo(() => {
    try {
      const rule = rules.find((rule) => rule.label === name),
        tensor = data?.[name]
      if (!rule || !isDataTensor(tensor) || !tensor.boxGrid) throw new Error('기록된 Box Grid 데이터가 없습니다.')
      const accessor = createDataTensorAccessor(rule.result, tensor)
      const leaf: CalculationInputLeaf = {
        dtype: rule.result.dtype === 'float32' ? 'float32' : 'float64',
        shape: accessor.shape,
        data: Array.from({ length: accessor.size }, (_, i) => Number(accessor.at(i))),
        axes: accessor.shape.map((_, axis) => ({
          name: axis < 5 ? projectionAxes[axis] : axis === 5 ? 'amplitudePhase' : 'component',
          unit: rule.result.axes?.[axis]?.unit,
          ticks: accessor.tensor.axes?.[axis]?.ticks ?? [],
        })),
        tensorOrder: Number('tensorOrder' in rule.result ? rule.result.tensorOrder : 0),
        boxGrid: tensor.boxGrid,
        unit: rule.result.unit,
      }
      return { leaf }
    } catch (error) {
      return { error: String(error instanceof Error ? error.message : error) }
    }
  }, [name, rules, data])
  if (!parsed.leaf)
    return (
      <p role="alert" className="p-3">
        {parsed.error}
      </p>
    )
  return (
    <BoxGridControls
      key={name}
      name={name}
      leaf={parsed.leaf}
      displayUnit={displayUnit}
      renderViewer={renderViewer}
      canOverlayGeometry={canOverlayGeometry}
      geometryBlockedReason={geometryBlockedReason}
      recordReference={recordReference ?? `record[${JSON.stringify(name)}]`}
    />
  )
}

function BoxGridControls({
  name,
  leaf,
  displayUnit,
  renderViewer,
  canOverlayGeometry,
  geometryBlockedReason,
  recordReference,
}: {
  name: string
  leaf: CalculationInputLeaf
  displayUnit: UcumUnit
  renderViewer: (data: HeatmapRenderData, geometryOpacity: number) => ReactNode
  canOverlayGeometry: boolean
  geometryBlockedReason?: string
  recordReference: string
}) {
  const comparison = useViewerComparison()
  const comparing = Boolean(comparison)
  const longest = useMemo(
    () =>
      [...projectionAxes].sort((a, b) => leaf.shape[projectionAxes.indexOf(b)] - leaf.shape[projectionAxes.indexOf(a)]),
    [leaf],
  )
  const [kind, setKind] = useViewerSetting<PlotKind>('box.kind', 'heatmap')
  const [axes, setAxes] = useViewerSetting<ProjectionAxis[]>('box.axes', longest.slice(0, 2))
  const [representation, setRepresentation] = useViewerSetting<'amplitude' | 'phase'>('box.representation', 'amplitude')
  const [component, setComponent] = useViewerSetting<number | 'magnitude' | 'arrows'>(
    'box.component',
    leaf.shape[6] === 1 ? 0 : 'magnitude',
  )
  const [reduce, setReduce] = useViewerSetting<Partial<Record<ProjectionAxis, ProjectionReduction>>>('box.reduce', {})
  const [overlay, setOverlay] = useViewerSetting('box.overlay', true)
  const [geometryOpacity, setGeometryOpacity] = useViewerSetting('box.geometryOpacity', 0.8)
  const [bins, setBins] = useViewerSetting<number | undefined>('box.bins', undefined)
  const [animation, setAnimation] = useViewerSetting<'off' | 'oscillation' | 'time' | 'frequency'>(
    'box.animation',
    'off',
  )
  const [phase, setPhase] = useViewerSetting('box.phase', 0),
    [frameIndex, setFrameIndex] = useViewerSetting('box.frameIndex', 0)
  const [playing, setPlaying] = useViewerSetting('box.playing', false),
    [repeat, setRepeat] = useViewerSetting('box.repeat', true),
    [speed, setSpeed] = useViewerSetting('box.speed', 1)
  const [fixed, setFixed] = useViewerSetting<readonly [number, number] | null>('box.fixed', null)
  const [result, setResult] = useState<ReturnType<typeof calculateBoxGridView>>()
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const [renderError, setRenderError] = useState('')
  const rangeCache = useRef<{ key: string; value: [number, number] } | null>(null)
  const vectorComponents = boxGridVectorComponents(leaf)
  const spatial = axes.every((axis) => ['x', 'y', 'z'].includes(axis))
  const arrowsAllowed = kind === 'cloud' && spatial && !!vectorComponents && representation !== 'phase'
  const actualComponent =
    component === 'arrows' ? 'magnitude' : representation === 'phase' && component === 'magnitude' ? 0 : component
  const effectiveAxes = kind === 'histogram' ? [...projectionAxes] : axes
  const frame =
    animation === 'oscillation'
      ? { phase: (phase * Math.PI) / 180 }
      : animation === 'time' || animation === 'frequency'
        ? {
            axis: animation,
            index: comparison ? frameIndex : Math.min(frameIndex, leaf.shape[animation === 'time' ? 3 : 4] - 1),
          }
        : undefined
  const options: BoxGridProjectionOptions = {
    axes: effectiveAxes,
    representation,
    component: actualComponent,
    reduce,
    frame,
  }
  const optionKey = JSON.stringify(options)
  const axesKey = effectiveAxes.join(',')
  const rangeKey = JSON.stringify({
    kind,
    axes: effectiveAxes,
    representation,
    component: actualComponent,
    reduce,
    animation,
  })
  const requestKey = `${optionKey}:${component === 'arrows' && arrowsAllowed}`
  const [completedKey, setCompletedKey] = useState('')
  const invalidSetting =
    comparison &&
    ((typeof component === 'number' && (!Number.isInteger(component) || component < 0 || component >= leaf.shape[6])) ||
      (representation === 'phase' && leaf.shape[5] !== 2) ||
      (component === 'arrows' && !arrowsAllowed) ||
      ((animation === 'time' || animation === 'frequency') &&
        (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= leaf.shape[animation === 'time' ? 3 : 4])) ||
      Object.entries(reduce).some(
        ([axis, reduction]) =>
          reduction.method === 'index' &&
          (!Number.isInteger(reduction.index ?? 0) ||
            (reduction.index ?? 0) < 0 ||
            (reduction.index ?? 0) >= leaf.shape[projectionAxes.indexOf(axis as ProjectionAxis)]),
      ))
      ? '저장된 성분·프레임·집계 설정을 현재 데이터 shape에 적용할 수 없습니다. 공통 툴바에서 수정하세요.'
      : ''
  const comparisonBusy = useComparisonBusy(busy || Boolean(invalidSetting) || completedKey !== requestKey)
  useEffect(() => {
    rangeCache.current = null
    if (comparing) return
    setPlaying(false)
    setFrameIndex(0)
    setPhase(0)
    setResult(undefined)
    setReduce((current) =>
      Object.fromEntries(
        Object.entries(current).map(([axis, reduction]) => [
          axis,
          {
            ...reduction,
            ...(reduction.method === 'index'
              ? {
                  index: Math.min(reduction.index ?? 0, leaf.shape[projectionAxes.indexOf(axis as ProjectionAxis)] - 1),
                }
              : {}),
          },
        ]),
      ),
    )
    setComponent((current) =>
      leaf.shape[6] === 1 ? 0 : typeof current === 'number' && current >= leaf.shape[6] ? 0 : current,
    )
    rangeCache.current = null
  }, [leaf, comparing, setPlaying, setFrameIndex, setPhase, setReduce, setComponent])
  useEffect(() => {
    if (invalidSetting) {
      setBusy(false)
      return
    }
    setBusy(true)
    setError('')
    let active = true
    const worker = new Worker(new URL('./boxGridView.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = ({
      data,
    }: MessageEvent<{ result?: ReturnType<typeof calculateBoxGridView>; error?: string }>) => {
      if (!active) return
      if (data.result) {
        if (rangeCache.current?.key !== rangeKey)
          rangeCache.current = { key: rangeKey, value: data.result.scalar.range }
        if (animation !== 'off') data.result.scalar.range = rangeCache.current.value
        setResult(data.result)
        setCompletedKey(requestKey)
      }
      setError(data.error ?? '')
      setBusy(false)
    }
    worker.onerror = (event) => {
      if (active) {
        setError(event.message || '표시 데이터 계산에 실패했습니다.')
        setBusy(false)
        if (!comparing) setPlaying(false)
      }
    }
    worker.postMessage({
      leaf,
      options: JSON.parse(optionKey),
      arrows: component === 'arrows' && arrowsAllowed,
      animationRange: animation !== 'off' && rangeCache.current?.key !== rangeKey,
    })
    return () => {
      active = false
      worker.terminate()
    }
  }, [
    leaf,
    optionKey,
    rangeKey,
    requestKey,
    component,
    arrowsAllowed,
    animation,
    invalidSetting,
    comparing,
    setPlaying,
  ])
  useEffect(() => {
    if (
      !playing ||
      busy ||
      error ||
      invalidSetting ||
      completedKey !== requestKey ||
      (comparison && (!comparison.controlsOwner || comparison.suspended || comparisonBusy))
    )
      return
    const timer = window.setTimeout(() => {
      const max = animation === 'oscillation' ? 360 : leaf.shape[animation === 'time' ? 3 : 4]
      if (animation === 'oscillation') {
        const next = phase + 18
        if (next >= max && !repeat) {
          setPlaying(false)
          setPhase(360)
        } else setPhase(next % 360)
      } else {
        const next = frameIndex + 1
        if (next >= max && !repeat) setPlaying(false)
        else setFrameIndex(next % max)
      }
    }, 100 / speed)
    return () => window.clearTimeout(timer)
  }, [
    playing,
    busy,
    error,
    completedKey,
    requestKey,
    animation,
    leaf,
    phase,
    frameIndex,
    repeat,
    speed,
    comparison,
    comparisonBusy,
    invalidSetting,
    setPlaying,
    setPhase,
    setFrameIndex,
  ])
  const range = useMemo(() => fixed ?? result?.scalar.range ?? [0, 0], [fixed, result])
  const renderData = useMemo(() => {
    if (
      !result ||
      result.scalar.axes.map((axis) => axis.name).join(',') !== axesKey ||
      kind === 'histogram' ||
      kind === 'line' ||
      (kind === 'heatmap' && !overlay)
    )
      return undefined
    let plane: { axis: number; coordinate: number } | undefined
    if (kind === 'heatmap') {
      const normal = [0, 1, 2].find((axis) => !axes.includes(projectionAxes[axis]))!
      const reduction = reduce[projectionAxes[normal]]
      plane = {
        axis: normal,
        coordinate:
          reduction?.method === 'index'
            ? Number(leaf.axes[normal].ticks[reduction.index ?? 0])
            : leaf.boxGrid.size[normal] / 2,
      }
    }
    return createPointCloudData(result.scalar, {
      identity: `${name}:${kind}:${axes.join(',')}`,
      leaf: spatial ? leaf : undefined,
      displayUnit,
      vectors: component === 'arrows' && arrowsAllowed ? result.vectors : undefined,
      plane,
      range,
    })
  }, [result, kind, overlay, axes, reduce, leaf, name, spatial, displayUnit, component, arrowsAllowed, range, axesKey])
  const unit = animation !== 'oscillation' && representation === 'phase' ? 'rad' : leaf.unit
  const changeKind = (next: PlotKind) => {
    if (next === kind) return
    setResult(undefined)
    setKind(next)
    setPlaying(false)
    setAnimation('off')
    setFixed(null)
    const nextAxes =
      next === 'line'
        ? ((leaf.shape[3] >= leaf.shape[4] ? ['frequency', 'time'] : ['time', 'frequency']) as ProjectionAxis[])
        : longest.slice(0, next === 'cloud' ? 3 : 2)
    setAxes(nextAxes)
    setComponent(
      next === 'cloud' &&
        nextAxes.every((axis) => ['x', 'y', 'z'].includes(axis)) &&
        vectorComponents &&
        representation !== 'phase'
        ? 'arrows'
        : leaf.shape[6] === 1
          ? 0
          : representation === 'phase'
            ? 0
            : 'magnitude',
    )
  }
  const ready =
    !busy && completedKey === requestKey && !error && !invalidSetting && !name.startsWith('@visualizations.')
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white [&_button]:min-h-8 [&_button]:rounded [&_button]:border [&_button]:px-3 [&_button]:text-sm [&_button]:font-medium [&_button:disabled]:opacity-40 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-sky-600 [&_input[type=number]]:w-20 [&_input[type=number]]:rounded [&_input[type=number]]:border [&_input[type=number]]:p-1 [&_select]:min-h-8 [&_select]:rounded [&_select]:border [&_select]:bg-white [&_select]:px-2">
      <ViewerControls>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-2 text-sm" aria-label="시각화 도구모음">
          <span className="font-semibold">시각화</span>
          {(
            [
              ['histogram', 'Histogram'],
              ['line', 'Line Chart'],
              ['heatmap', 'Heatmap'],
              ['cloud', '3D Point cloud'],
            ] as const
          ).map(([value, title]) => (
            <button
              key={value}
              aria-pressed={kind === value}
              className={kind === value ? 'border-sky-600 bg-sky-50 text-sky-900' : 'text-slate-700'}
              onClick={() => changeKind(value)}
            >
              {title}
            </button>
          ))}
          <button
            className="ml-auto"
            disabled={!ready}
            title={
              name.startsWith('@visualizations.')
                ? '자동 시각화는 Calculation 입력이 아닙니다.'
                : '현재 설정의 Calculation 변환식 복사'
            }
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  projectionCode(
                    recordReference,
                    options,
                    component === 'arrows' && arrowsAllowed ? vectorComponents : undefined,
                  ),
                )
                toast.success(
                  component === 'arrows' && arrowsAllowed
                    ? 'X·Y·Z·벡터 크기 변환식 4줄을 복사했습니다.'
                    : 'Calculation 변환식을 복사했습니다.',
                )
              } catch {
                toast.error('클립보드에 복사하지 못했습니다.')
              }
            }}
          >
            {component === 'arrows' && arrowsAllowed ? '변환 코드 4줄 복사' : '변환 코드 복사'}
          </button>
        </div>
        <details open className="max-h-[40%] shrink-0 overflow-auto border-b text-sm">
          <summary className="cursor-pointer px-3 py-1 font-semibold">값·성분 / 축·집계 설정</summary>
          <div className="flex flex-wrap items-center gap-4 px-3 py-2">
            <label>
              채널{' '}
              <select
                aria-label="채널"
                value={representation}
                disabled={leaf.shape[5] !== 2 || animation === 'oscillation'}
                onChange={(event) => {
                  const next = event.target.value as typeof representation
                  setRepresentation(next)
                  if (next === 'phase') setComponent(0)
                  setFixed(null)
                }}
              >
                <option value="amplitude">{leaf.shape[5] === 2 ? 'Amplitude' : 'Value'}</option>
                {leaf.shape[5] === 2 ? <option value="phase">Phase (rad)</option> : null}
              </select>
            </label>
            <label>
              성분{' '}
              <select
                aria-label="성분"
                value={component === 'arrows' && !arrowsAllowed ? actualComponent : component}
                onChange={(event) => {
                  setComponent(
                    event.target.value === 'magnitude' || event.target.value === 'arrows'
                      ? event.target.value
                      : Number(event.target.value),
                  )
                  setFixed(null)
                }}
              >
                <option value="magnitude" disabled={representation === 'phase'}>
                  절대값 · 벡터 크기
                </option>
                {leaf.boxGrid.components.map((label, i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
                {kind === 'cloud' ? (
                  <option value="arrows" disabled={!arrowsAllowed}>
                    화살표 (XYZ 벡터 전용)
                  </option>
                ) : null}
              </select>
            </label>
            {kind !== 'histogram' ? (
              axes.map((axis, i) => (
                <label key={i}>
                  {kind === 'line'
                    ? i === 0
                      ? 'Sub axis · line 구분'
                      : 'Main axis · 가로축'
                    : kind === 'heatmap'
                      ? i === 0
                        ? '세로축'
                        : '가로축'
                      : `표시 축 ${i + 1}`}{' '}
                  <select
                    aria-label={`표시 축 ${i + 1}`}
                    value={axis}
                    onChange={(event) => {
                      const next = [...axes]
                      next[i] = event.target.value as ProjectionAxis
                      setResult(undefined)
                      setAxes(next)
                      setPlaying(false)
                      setAnimation('off')
                      setFixed(null)
                      if (component === 'arrows' && !next.every((a) => ['x', 'y', 'z'].includes(a)))
                        setComponent('magnitude')
                    }}
                  >
                    {projectionAxes.map((value) => (
                      <option key={value} value={value} disabled={axes.includes(value) && axis !== value}>
                        {axisLabels[value]} · {leaf.shape[projectionAxes.indexOf(value)]}
                      </option>
                    ))}
                  </select>
                </label>
              ))
            ) : (
              <label>
                Histogram bins{' '}
                <input
                  aria-label="Histogram bins"
                  type="number"
                  min={1}
                  max={100}
                  placeholder="자동"
                  value={bins ?? ''}
                  onChange={(event) =>
                    setBins(
                      event.target.value
                        ? Math.max(1, Math.min(100, Math.trunc(Number(event.target.value))))
                        : undefined,
                    )
                  }
                />
              </label>
            )}
          </div>
          {kind !== 'histogram' ? (
            <div className="flex flex-wrap gap-4 border-t px-3 py-2">
              <span className="font-semibold">나머지 축 집계</span>
              {projectionAxes
                .filter((axis) => !axes.includes(axis))
                .map((axis) => {
                  const reduction = reduce[axis] ?? { method: 'mean' as const },
                    axisIndex = projectionAxes.indexOf(axis)
                  return (
                    <label key={axis}>
                      {axisLabels[axis]}{' '}
                      <select
                        aria-label={`${axis} 집계`}
                        disabled={animation === axis}
                        value={reduction.method}
                        onChange={(event) => {
                          setReduce({
                            ...reduce,
                            [axis]: { method: event.target.value as ProjectionReduction['method'], index: 0 },
                          })
                          setPlaying(false)
                        }}
                      >
                        {['sum', 'mean', 'min', 'max', 'median', 'std', 'index'].map((method) => (
                          <option key={method} value={method}>
                            {method === 'index' ? '개별 index' : method}
                          </option>
                        ))}
                      </select>
                      {reduction.method === 'index' ? (
                        <>
                          {' '}
                          <input
                            aria-label={`${axis} index`}
                            type="number"
                            min={0}
                            max={leaf.shape[axisIndex] - 1}
                            value={reduction.index ?? 0}
                            onChange={(event) =>
                              setReduce({
                                ...reduce,
                                [axis]: {
                                  method: 'index',
                                  index: Math.max(
                                    0,
                                    Math.min(leaf.shape[axisIndex] - 1, Math.trunc(Number(event.target.value) || 0)),
                                  ),
                                },
                              })
                            }
                          />{' '}
                          = {leaf.axes[axisIndex].ticks[reduction.index ?? 0]} {leaf.axes[axisIndex].unit}
                        </>
                      ) : null}
                    </label>
                  )
                })}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-4 border-t px-3 py-2">
            {kind === 'cloud' || kind === 'heatmap' ? (
              <label
                title={
                  !canOverlayGeometry
                    ? (geometryBlockedReason ?? 'Geometry와 결과의 좌표계 일치를 확인할 수 없습니다.')
                    : !spatial
                      ? '공간 축 조합에서만 사용할 수 있습니다.'
                      : ''
                }
              >
                <input
                  type="checkbox"
                  checked={overlay && spatial && canOverlayGeometry}
                  disabled={!spatial || !canOverlayGeometry}
                  onChange={(event) => setOverlay(event.target.checked)}
                />{' '}
                Geometry 겹치기
              </label>
            ) : null}
            {(kind === 'cloud' || kind === 'heatmap') && overlay && spatial && canOverlayGeometry ? (
              <label>
                Geometry 투명도{' '}
                <input
                  aria-label="Geometry 투명도"
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={geometryOpacity}
                  onChange={(event) => setGeometryOpacity(Number(event.target.value))}
                />
              </label>
            ) : null}
            <label hidden={kind === 'histogram'}>
              <input
                type="checkbox"
                checked={!!fixed}
                onChange={(event) => setFixed(event.target.checked ? ([...range] as [number, number]) : null)}
              />{' '}
              값 범위 고정
            </label>
            {fixed
              ? [0, 1].map((end) => (
                  <input
                    key={end}
                    aria-label={end ? '범위 최댓값' : '범위 최솟값'}
                    type="number"
                    value={fixed[end]}
                    onChange={(event) => {
                      const next: [number, number] = [...fixed]
                      next[end] = Number(event.target.value)
                      if (Number.isFinite(next[end])) setFixed(next)
                    }}
                  />
                ))
              : null}
          </div>
        </details>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2 text-sm" aria-label="재생 설정">
          <span className="font-semibold">재생</span>
          <select
            aria-label="Animation 모드"
            value={animation}
            onChange={(event) => {
              setPlaying(false)
              setAnimation(event.target.value as typeof animation)
              setPhase(0)
              setFrameIndex(0)
              setFixed(null)
            }}
          >
            <option value="off">정적</option>
            <option
              value="oscillation"
              disabled={leaf.shape[5] !== 2 || !leaf.axes[4].ticks.some((tick) => Number(tick) > 0)}
            >
              진동 · 공통 위상
            </option>
            {(['time', 'frequency'] as const).map((axis) => (
              <option
                key={axis}
                value={axis}
                disabled={(kind !== 'histogram' && axes.includes(axis)) || leaf.shape[axis === 'time' ? 3 : 4] < 2}
              >
                {axisLabels[axis]} index 순회
              </option>
            ))}
          </select>
          {animation !== 'off' ? (
            <>
              <button
                aria-pressed={playing}
                disabled={!!error || Boolean(invalidSetting)}
                onClick={() => setPlaying(!playing)}
              >
                {playing ? '일시정지' : '재생'}
              </button>
              <input
                aria-label="Animation 프레임"
                type="range"
                min={0}
                max={animation === 'oscillation' ? 360 : leaf.shape[animation === 'time' ? 3 : 4] - 1}
                value={animation === 'oscillation' ? phase : frameIndex}
                aria-valuetext={String(animation === 'oscillation' ? phase : frameIndex)}
                disabled={Boolean(invalidSetting)}
                onChange={(event) => {
                  setPlaying(false)
                  if (animation === 'oscillation') setPhase(Number(event.target.value))
                  else setFrameIndex(Number(event.target.value))
                }}
              />
              {comparison && animation !== 'oscillation' ? (
                <input
                  aria-label="Animation 프레임 번호"
                  type="number"
                  min={0}
                  max={leaf.shape[animation === 'time' ? 3 : 4] - 1}
                  value={frameIndex}
                  onChange={(event) => {
                    setPlaying(false)
                    setFrameIndex(Number(event.target.value))
                  }}
                />
              ) : null}
              <span>
                {animation === 'oscillation'
                  ? `${phase.toFixed(0)}°`
                  : `${frameIndex} · ${leaf.axes[animation === 'time' ? 3 : 4].ticks[frameIndex] ?? '현재 데이터 범위 밖'} ${leaf.axes[animation === 'time' ? 3 : 4].unit ?? ''}`}
              </span>
              <label>
                속도{' '}
                <select aria-label="재생 속도" value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                  {[0.25, 0.5, 1, 2, 4].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={repeat} onChange={(event) => setRepeat(event.target.checked)} /> 반복
              </label>
            </>
          ) : null}
        </div>
      </ViewerControls>
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-3 py-2 text-xs text-slate-600" role="status">
        <strong>{name}</strong>
        <span>
          {animation === 'oscillation'
            ? '순간값 · 공통 위상 (실제 시간 신호 합성 아님)'
            : representation === 'phase'
              ? 'Phase'
              : 'Amplitude / Value'}{' '}
          · {actualComponent === 'magnitude' ? '벡터 크기' : leaf.boxGrid.components[actualComponent]} [{unit}]
        </span>
        <span>{range[0].toPrecision(4)}</span>
        <span className="h-3 w-24" style={{ background: 'linear-gradient(to right, blue, lime, red)' }} />
        <span>{range[1].toPrecision(4)}</span>
        {busy ? <span>계산 중…</span> : null}
        {kind === 'histogram' ? <span>5차원 중간값—return 전 추가 축소 필요</span> : null}
      </div>
      {invalidSetting || error || renderError || range[0] > range[1] ? (
        <p role="alert" className="p-3 text-red-700">
          {invalidSetting || error || renderError || '범위 최솟값은 최댓값 이하여야 합니다.'}
        </p>
      ) : null}
      <div className="min-h-0 flex-1" aria-busy={busy}>
        {result && !invalidSetting && range[0] <= range[1] ? (
          kind === 'cloud' || (kind === 'heatmap' && overlay && canOverlayGeometry && spatial) ? (
            renderData ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  {overlay && canOverlayGeometry && spatial ? (
                    renderViewer(renderData, geometryOpacity)
                  ) : (
                    <JscadViewer
                      layers={noLayers}
                      lengthUnit={displayUnit}
                      showScaleBar={spatial}
                      heatmapRenderData={renderData}
                      onRenderStart={() => {}}
                      onRenderEnd={() => {}}
                      onRenderError={setRenderError}
                    />
                  )}
                </div>
                <div className="px-3 py-1 text-xs">
                  {result.scalar.axes
                    .map(
                      (axis) =>
                        `${axis.name}: ${axis.ticks[0]} ~ ${axis.ticks[axis.ticks.length - 1]} ${axis.unit ?? ''}`,
                    )
                    .join(' · ')}{' '}
                  · {renderData.displayedCount.toLocaleString()} / {result.scalar.values.length.toLocaleString()} 표본
                  표시 (집계·복사는 전체 데이터)
                  {kind === 'cloud'
                    ? ` · 0값 ${renderData.hiddenZeroCount.toLocaleString()}개 숨김 · 점 면적 ∝ |값|`
                    : null}
                </div>
              </div>
            ) : null
          ) : (
            <ScalarPlot
              plot={result.scalar}
              kind={kind}
              range={range}
              bins={bins}
              unit={unit}
              lockHistogramRange={animation !== 'off'}
            />
          )
        ) : null}
      </div>
      {result && !invalidSetting ? (
        <PlotProbe key={result.scalar.axes.map((axis) => axis.name).join(',')} plot={result.scalar} />
      ) : null}
    </div>
  )
}
