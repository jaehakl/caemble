import {
  useComparisonBusy,
  useComparisonFrequencies,
  useViewerComparison,
  useViewerSetting,
  ViewerControls,
} from './comparisonSettings'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BoxGridToolbar } from './BoxGridToolbar'
import { ViewerLayout } from './ViewerTools'
import type { RecordedData, RecordedDataRule, UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import {
  boxGridFrequenciesHz,
  projectionAxes,
  projectionCode,
  type BoxGridProjectionOptions,
  type ProjectionAxis,
  type ProjectionReduction,
} from '@/lib/calculation/boxGridProject'
import {
  boxGridVectorComponents,
  opticalPlotData,
  type calculateBoxGridView,
  type PlotKind,
  type BoxGridAnimation,
} from './boxGridViewData'
import { createPointCloudData } from './pointCloudData'
import { ScalarPlot } from './ScalarPlot'
import JscadViewer from './JscadViewer'
import type { HeatmapRenderData } from './structuredField'

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
    <ViewerLayout>
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
    </ViewerLayout>
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
  const surfacePower = leaf.boxGrid.sampling === 'surface-integral'
  const sourceSampled = leaf.boxGrid.frequencyKind === 'source-sampled'
  const [wavelengthDisplay, setWavelengthDisplay] = useViewerSetting('box.wavelength', true)
  const labels = surfacePower ? { ...axisLabels, x: 'u', y: 'v', frequency: '입력 파장 / 주파수' } : axisLabels
  const longest = useMemo(
    () =>
      [...projectionAxes].sort((a, b) => leaf.shape[projectionAxes.indexOf(b)] - leaf.shape[projectionAxes.indexOf(a)]),
    [leaf],
  )
  const [kind, setKind] = useViewerSetting<PlotKind>('box.kind', surfacePower ? 'heatmap' : 'cloud')
  const [axes, setAxes] = useViewerSetting<ProjectionAxis[]>('box.axes', surfacePower ? ['y', 'x'] : ['x', 'y', 'z'])
  const [representation, setRepresentation] = useViewerSetting<'amplitude' | 'phase'>('box.representation', 'amplitude')
  const [component, setComponent] = useViewerSetting<number | 'magnitude' | 'arrows'>(
    'box.component',
    leaf.shape[6] === 1 ? 0 : 'magnitude',
    'item',
    (value) => typeof value !== 'number' || value < leaf.shape[6],
  )
  const [reduce, setReduce] = useViewerSetting<Partial<Record<ProjectionAxis, ProjectionReduction>>>(
    'box.reduce',
    {
      ...(surfacePower
        ? { x: { method: 'sum' as const }, y: { method: 'sum' as const }, z: { method: 'sum' as const } }
        : {}),
      frequency: sourceSampled ? { method: 'index', index: 0 } : { method: 'sum' },
    },
    'item',
    (value) =>
      Object.entries(value).every(
        ([axis, reduction]) =>
          reduction.method !== 'index' ||
          (reduction.index ?? 0) < leaf.shape[projectionAxes.indexOf(axis as ProjectionAxis)],
      ),
  )
  const [overlay, setOverlay] = useViewerSetting('box.overlay', true)
  const [geometryOpacity, setGeometryOpacity] = useViewerSetting('box.geometryOpacity', 0.5)
  const [bins, setBins] = useViewerSetting<number | undefined>('box.bins', undefined)
  const [animation, setAnimation] = useViewerSetting<BoxGridAnimation>(
    'box.animation',
    () => {
      if (leaf.shape[5] !== 2) return 'off'
      try {
        const frequencies = boxGridFrequenciesHz(leaf)
        return frequencies.some((frequency) => frequency > 0) ? 'oscillation' : 'off'
      } catch {
        return 'off'
      }
    },
    'item',
    (value) =>
      value === 'off' ||
      (value === 'oscillation'
        ? leaf.shape[5] === 2
        : leaf.shape[value === 'component' ? 6 : projectionAxes.indexOf(value)] > 1),
  )
  const animationAxis = animation === 'off' || animation === 'oscillation' ? undefined : animation
  const animationLength = animationAxis
    ? leaf.shape[animationAxis === 'component' ? 6 : projectionAxes.indexOf(animationAxis)]
    : 1
  const [timeSeconds, setTimeSeconds] = useViewerSetting('box.timeSeconds', 0),
    [frameIndex, setFrameIndex] = useViewerSetting('box.frameIndex', 0, 'item', (value) => value < animationLength)
  const [durationOverride, setDurationOverride] = useViewerSetting<number | null>('box.durationSeconds', null)
  const [playing, setPlaying] = useViewerSetting('box.playing', false),
    [repeat, setRepeat] = useViewerSetting('box.repeat', true),
    [speed, setSpeed] = useViewerSetting('box.speed', 1)
  const [fixed, setFixed] = useViewerSetting<readonly [number, number] | null>('box.fixed', null)
  const [result, setResult] = useState<ReturnType<typeof calculateBoxGridView>>()
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const [renderError, setRenderError] = useState('')
  const rangeCache = useRef<{ key: string; value: [number, number]; distribution?: [number, number] } | null>(null)
  const vectorComponents = boxGridVectorComponents(leaf)
  const spatial = axes.every((axis) => ['x', 'y', 'z'].includes(axis))
  const arrowsAllowed = kind === 'cloud' && spatial && !!vectorComponents && representation !== 'phase'
  const actualComponent =
    animation === 'component'
      ? frameIndex
      : component === 'arrows'
        ? 'magnitude'
        : representation === 'phase' && component === 'magnitude'
          ? 0
          : component
  const effectiveAxes = axes
  const frequencyIndex =
    !effectiveAxes.includes('frequency') && reduce.frequency?.method === 'index' ? reduce.frequency.index : undefined
  const frequencyInfo = useMemo(() => {
    try {
      if (leaf.shape[5] !== 2) throw new Error('진동 재생에는 진폭·위상 채널이 필요합니다.')
      const frequencies = boxGridFrequenciesHz(leaf)
      if (
        frequencyIndex !== undefined &&
        (!Number.isInteger(frequencyIndex) || frequencyIndex < 0 || frequencyIndex >= frequencies.length)
      )
        throw new Error('frequency index가 범위를 벗어났습니다.')
      let minimum = Infinity,
        maximum = 0
      for (const frequency of frequencyIndex === undefined ? frequencies : [frequencies[frequencyIndex]]) {
        if (frequency > 0) minimum = Math.min(minimum, frequency)
        maximum = Math.max(maximum, Math.abs(frequency))
      }
      return { minimum: minimum === Infinity ? 0 : minimum, maximum, error: '' }
    } catch (error) {
      return { minimum: 0, maximum: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }, [leaf, frequencyIndex])
  const [minimumFrequency, maximumFrequency] = useComparisonFrequencies(frequencyInfo.minimum, frequencyInfo.maximum)
  const durationSeconds = durationOverride ?? (minimumFrequency > 0 ? 1 / minimumFrequency : 1)
  const timeStep = maximumFrequency > 0 ? 1 / maximumFrequency / 20 : 0
  const oscillationError =
    frequencyInfo.error ||
    (minimumFrequency <= 0 ? '선택된 양의 주파수가 없어 진동을 재생할 수 없습니다.' : '') ||
    (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || timeStep <= 0
      ? '재생 시간 범위를 표현할 수 없습니다.'
      : '')
  const frequencySelection = JSON.stringify([effectiveAxes.includes('frequency'), reduce.frequency])
  const previousFrequencySelection = useRef(frequencySelection)
  useEffect(() => {
    if (previousFrequencySelection.current === frequencySelection) return
    previousFrequencySelection.current = frequencySelection
    if (comparison && !comparison.controlsOwner) return
    setPlaying(false)
    setTimeSeconds(0)
    setDurationOverride(null)
  }, [frequencySelection, comparison, setPlaying, setTimeSeconds, setDurationOverride])
  const frame = animation === 'oscillation' ? { timeSeconds } : undefined
  const effectiveReduce = useMemo(
    () =>
      animationAxis && animationAxis !== 'component'
        ? { ...reduce, [animationAxis]: { method: 'index' as const, index: frameIndex } }
        : reduce,
    [animationAxis, reduce, frameIndex],
  )
  const options: BoxGridProjectionOptions = {
    axes: effectiveAxes,
    representation,
    component: actualComponent,
    reduce: effectiveReduce,
    frame,
  }
  const optionKey = JSON.stringify(options)
  const axesKey = effectiveAxes.join(',')
  const rangeKey = JSON.stringify({
    kind,
    axes: effectiveAxes,
    representation,
    component: animation === 'component' ? 'component-sweep' : actualComponent,
    reduce,
    animation,
  })
  const requestKey = `${optionKey}:${component === 'arrows' && arrowsAllowed}`
  const [completedKey, setCompletedKey] = useState('')
  const viewKey = `${rangeKey}:${component === 'arrows' && arrowsAllowed}`
  const [completedView, setCompletedView] = useState<{ leaf: CalculationInputLeaf; key: string }>()
  const frameUpdate = animation !== 'off' && result && completedView?.leaf === leaf && completedView.key === viewKey
  const showCalculationStatus = busy && !frameUpdate
  const invalidSetting =
    animation === 'oscillation' && oscillationError
      ? oscillationError
      : comparison &&
          ((typeof component === 'number' &&
            (!Number.isInteger(component) || component < 0 || component >= leaf.shape[6])) ||
            (representation === 'phase' && leaf.shape[5] !== 2) ||
            (component === 'arrows' && !arrowsAllowed) ||
            (animationAxis && (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= animationLength)) ||
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
    setTimeSeconds(0)
    setDurationOverride(null)
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
  }, [leaf, comparing, setPlaying, setFrameIndex, setTimeSeconds, setDurationOverride, setReduce, setComponent])
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
          rangeCache.current = {
            key: rangeKey,
            value: data.result.scalar.range,
            distribution: data.result.distribution?.range,
          }
        if (animation !== 'off') {
          data.result.scalar.range = rangeCache.current.value
          if (data.result.distribution && rangeCache.current.distribution)
            data.result.distribution.range = rangeCache.current.distribution
        }
        setResult(data.result)
        setCompletedKey(requestKey)
        setCompletedView({ leaf, key: viewKey })
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
      sweepAxis: animationAxis,
      histogramDistribution: kind === 'histogram' && axes.length === 0,
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
    viewKey,
    component,
    arrowsAllowed,
    animation,
    animationAxis,
    kind,
    axes.length,
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
      const max = animationLength
      if (animation === 'oscillation') {
        if (timeSeconds >= durationSeconds) {
          if (repeat) setTimeSeconds(0)
          else setPlaying(false)
        } else {
          const next = Math.min(durationSeconds, timeSeconds + timeStep)
          setTimeSeconds(next)
          if (next >= durationSeconds && !repeat) setPlaying(false)
        }
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
    animationLength,
    leaf,
    timeSeconds,
    durationSeconds,
    timeStep,
    frameIndex,
    repeat,
    speed,
    comparison,
    comparisonBusy,
    invalidSetting,
    setPlaying,
    setTimeSeconds,
    setFrameIndex,
  ])
  const range = useMemo(() => fixed ?? result?.distribution?.range ?? result?.scalar.range ?? [0, 0], [fixed, result])
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
      const reduction = effectiveReduce[projectionAxes[normal]]
      plane = {
        axis: normal,
        coordinate:
          reduction?.method === 'index'
            ? Number(leaf.axes[normal].ticks[reduction.index ?? 0])
            : leaf.boxGrid.size[normal] / 2,
      }
    }
    return createPointCloudData(
      spatial ? result.scalar : opticalPlotData(result.scalar, sourceSampled && wavelengthDisplay, surfacePower),
      {
        identity: `${name}:${kind}:${axes.join(',')}`,
        leaf: spatial ? leaf : undefined,
        displayUnit,
        vectors: component === 'arrows' && arrowsAllowed ? result.vectors : undefined,
        plane,
        range,
      },
    )
  }, [
    result,
    kind,
    overlay,
    axes,
    effectiveReduce,
    leaf,
    name,
    spatial,
    displayUnit,
    component,
    arrowsAllowed,
    range,
    axesKey,
    sourceSampled,
    wavelengthDisplay,
    surfacePower,
  ])
  const unit = animation !== 'oscillation' && representation === 'phase' ? 'rad' : leaf.unit
  const stopAnimation = () => {
    setPlaying(false)
    if (animationAxis === 'component') setComponent(frameIndex)
    else if (animationAxis)
      setReduce((current) => ({ ...current, [animationAxis]: { method: 'index', index: frameIndex } }))
    setAnimation('off')
  }
  const changeKind = (next: PlotKind) => {
    if (next === kind) return
    stopAnimation()
    setResult(undefined)
    setKind(next)
    setFixed(null)
    if (next === 'histogram') return
    const count = next === 'cloud' ? 3 : next === 'heatmap' ? 2 : Math.min(2, Math.max(1, axes.length))
    const selected = [...new Set([...axes, ...longest])].slice(0, count)
    const ordered = projectionAxes.filter((axis) => selected.includes(axis))
    setAxes(next === 'heatmap' || (next === 'line' && count === 2) ? [...ordered].reverse() : ordered)
    if (component === 'arrows' && (next !== 'cloud' || !selected.every((axis) => ['x', 'y', 'z'].includes(axis))))
      setComponent('magnitude')
  }
  const changeRole = (axis: ProjectionAxis, role: 'space' | ProjectionReduction['method']) => {
    stopAnimation()
    const selected = role === 'space' ? [...new Set([...axes, axis])] : axes.filter((item) => item !== axis)
    if (selected.length > 3) return
    const ordered = projectionAxes.filter((item) => selected.includes(item))
    if (selected.length !== axes.length) {
      const nextKind =
        selected.length === 3
          ? 'cloud'
          : selected.length === 2
            ? 'heatmap'
            : selected.length === 1
              ? 'line'
              : 'histogram'
      setKind(nextKind)
      setAxes(nextKind === 'heatmap' ? [...ordered].reverse() : ordered)
      setResult(undefined)
    }
    if (role !== 'space') setReduce((current) => ({ ...current, [axis]: { method: role, index: 0 } }))
    if (component === 'arrows' && (selected.length !== 3 || !selected.every((item) => ['x', 'y', 'z'].includes(item))))
      setComponent('magnitude')
    setFixed(null)
  }
  const ready =
    !busy && completedKey === requestKey && !error && !invalidSetting && !name.startsWith('@visualizations.')
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-white">
      <ViewerControls>
        <BoxGridToolbar
          leaf={leaf}
          kind={kind}
          axes={axes}
          reduce={effectiveReduce}
          representation={representation}
          component={animation === 'component' ? frameIndex : component}
          arrowsAllowed={arrowsAllowed}
          onKind={changeKind}
          onRole={changeRole}
          onRepresentation={(next) => {
            stopAnimation()
            setRepresentation(next)
            if (next === 'phase') setComponent(0)
            setFixed(null)
          }}
          onComponent={(next) => {
            stopAnimation()
            setComponent(next)
            setFixed(null)
          }}
          onIndex={(axis, index) => {
            stopAnimation()
            if (axis === 'component') setComponent(index)
            else setReduce((current) => ({ ...current, [axis]: { method: 'index', index } }))
          }}
          overlay={overlay}
          geometryOpacity={geometryOpacity}
          overlayAvailable={spatial && canOverlayGeometry && (kind === 'cloud' || kind === 'heatmap')}
          geometryBlockedReason={!spatial ? '공간 좌표 축에서만 Geometry를 겹칠 수 있습니다.' : geometryBlockedReason}
          onOverlay={() => setOverlay(!overlay)}
          onOpacity={setGeometryOpacity}
          fixed={fixed}
          range={range}
          onFixed={setFixed}
          bins={bins}
          onBins={setBins}
          wavelengthDisplay={wavelengthDisplay}
          onWavelength={setWavelengthDisplay}
          animation={animation}
          playing={playing}
          repeat={repeat}
          speed={speed}
          timeSeconds={timeSeconds}
          durationSeconds={durationSeconds}
          oscillationError={oscillationError}
          playbackError={error || invalidSetting}
          onPlay={(axis) => {
            if (axis === animation) {
              setPlaying(!playing)
              return
            }
            stopAnimation()
            setAnimation(axis)
            setFrameIndex(
              axis === 'component'
                ? typeof component === 'number'
                  ? component
                  : 0
                : axis === 'oscillation'
                  ? 0
                  : (reduce[axis]?.index ?? 0),
            )
            setPlaying(true)
          }}
          onPause={() => setPlaying(false)}
          onRepeat={setRepeat}
          onSpeed={setSpeed}
          onTime={(time) => {
            setPlaying(false)
            setAnimation('oscillation')
            setTimeSeconds(time)
          }}
          onDuration={(duration) => {
            setPlaying(false)
            setTimeSeconds(0)
            setDurationOverride(duration)
          }}
          ready={ready}
          onCopy={async () => {
            try {
              await navigator.clipboard.writeText(
                projectionCode(
                  recordReference,
                  options,
                  component === 'arrows' && arrowsAllowed ? vectorComponents : undefined,
                ),
              )
              toast.success('Calculation 변환식을 복사했습니다.')
            } catch {
              toast.error('클립보드에 복사하지 못했습니다.')
            }
          }}
        />
      </ViewerControls>
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-3 py-2 text-xs text-slate-600" role="status">
        <strong>{name}</strong>
        {surfacePower ? (
          <span>
            픽셀 적분 전력 [W] · 기하광학 응답 ·{' '}
            {['x', 'y', 'z']
              .filter((axis) => !axes.includes(axis as ProjectionAxis))
              .map((axis) => `${labels[axis as ProjectionAxis]} ${reduce[axis as ProjectionAxis]?.method ?? 'mean'}`)
              .join(' · ')}
          </span>
        ) : null}
        {leaf.boxGrid.configuration ? (
          <span>{leaf.boxGrid.configuration === 'reference' ? '기준 배치' : '현재 배치'}</span>
        ) : null}
        {leaf.boxGrid.weighting === 'material-volume' ? <span>재료 체적 가중 평균</span> : null}
        <span>
          {animation === 'oscillation'
            ? '순간값 · 공통 시간'
            : representation === 'phase'
              ? 'Phase'
              : 'Amplitude / Value'}{' '}
          · {actualComponent === 'magnitude' ? '벡터 크기' : leaf.boxGrid.components[actualComponent]} [{unit}]
        </span>
        <span
          aria-hidden={!showCalculationStatus}
          className={`shrink-0 whitespace-nowrap ${showCalculationStatus ? '' : 'invisible'}`}
        >
          계산 중…
        </span>
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
              </div>
            ) : null
          ) : (
            <ScalarPlot
              plot={opticalPlotData(
                result.distribution ?? result.scalar,
                sourceSampled && wavelengthDisplay,
                surfacePower,
              )}
              histogramMarker={result.distribution ? result.scalar.values[0] : undefined}
              kind={kind}
              range={range}
              bins={bins}
              unit={unit}
              lockHistogramRange={animation !== 'off'}
            />
          )
        ) : null}
      </div>
    </div>
  )
}
