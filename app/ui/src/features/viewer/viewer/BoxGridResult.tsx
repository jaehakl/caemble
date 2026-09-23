import JscadViewer from './JscadViewer'
import {
  useComparisonBusy,
  useComparisonFrequencies,
  useViewerComparison,
  useViewerSetting,
  ViewerControls,
} from './comparisonSettings'
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { BoxGridOutputSettings } from './BoxGridOutputSettings'
import { ViewerSceneOnly } from './ViewerSceneLayers'
import { ViewerPlaybackRegistration } from './ViewerPlayback'
import type { ViewerPlaybackSource } from './viewerPlaybackState'
import { Copy, Layers } from 'lucide-react'
import { ViewerLayout, ViewerToolHosts, ViewerToolButton, ViewerOutputMenuHost, ViewerToolMenu } from './ViewerTools'
import type { RecordedData, RecordedDataRule, UcumUnit } from '@/lib/cad/model'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { CalculationInputLeaf } from '@/lib/calculation/types'
import {
  boxGridFrequenciesHz,
  boxGridTensorComponents,
  projectionAxes,
  projectionCode,
  type BoxGridProjectionOptions,
  type ProjectionAxis,
  type ProjectionReduction,
} from '@/lib/calculation/boxGridProject'
import {
  boxGridArrowComponents,
  boxGridVectorComponents,
  opticalPlotData,
  type calculateBoxGridView,
  type PlotKind,
  type BoxGridAnimation,
  type BoxGridComponentChoice,
} from './boxGridViewData'
import { createPointCloudData } from './pointCloudData'
import { ScalarPlot } from './ScalarPlot'
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
  recordReference,
  role,
}: {
  name: string
  rules: readonly RecordedDataRule[]
  data?: RecordedData
  displayUnit: UcumUnit
  renderViewer: (data: HeatmapRenderData, geometryOpacity: number) => ReactNode
  canOverlayGeometry: boolean
  geometryBlockedReason?: string
  recordReference?: string
  role?: 'space' | 'chart'
}) {
  const parentLayout = useContext(ViewerToolHosts)
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
          ticks:
            accessor.tensor.axes?.[axis]?.ticks ??
            (axis < 3 && accessor.shape[axis] === 1 ? [tensor.boxGrid!.size[axis] / 2] : []),
        })),
        tensorOrder: Number('tensorOrder' in rule.result ? rule.result.tensorOrder : 0),
        boxGrid: tensor.boxGrid,
        unit: rule.result.unit,
      }
      const positionAxes = projectionAxes.slice(0, 3).filter((_, index) => {
        const ticks = accessor.tensor.axes?.[index]?.ticks
        return (
          ticks?.length === leaf.shape[index] &&
          ticks.every((tick) => typeof tick === 'number' && Number.isFinite(tick))
        )
      })
      return { leaf, positionAxes }
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
      {!parentLayout ? <StandaloneOutputMenu name={name} /> : null}
      <BoxGridControls
        key={name}
        name={name}
        role={role}
        leaf={parsed.leaf}
        positionAxes={parsed.positionAxes}
        displayUnit={displayUnit}
        renderViewer={renderViewer}
        canOverlayGeometry={canOverlayGeometry}
        recordReference={recordReference ?? `record[${JSON.stringify(name)}]`}
      />
    </ViewerLayout>
  )
}

function StandaloneOutputMenu({ name }: { name: string }) {
  const menu = useContext(ViewerOutputMenuHost)
  return (
    <ViewerControls placement="data">
      <ViewerToolMenu label={`Output · ${name}`} icon={<Layers />} modal={false}>
        <div ref={menu?.setHost} className="max-h-[80vh] max-w-[calc(100vw-1rem)] overflow-auto p-2 text-xs" />
      </ViewerToolMenu>
    </ViewerControls>
  )
}

function BoxGridControls({
  positionAxes,
  name,
  leaf,
  displayUnit,
  renderViewer,
  canOverlayGeometry,
  recordReference,
  role,
}: {
  name: string
  leaf: CalculationInputLeaf
  positionAxes: ProjectionAxis[]
  displayUnit: UcumUnit
  renderViewer: (data: HeatmapRenderData, geometryOpacity: number) => ReactNode
  canOverlayGeometry: boolean
  recordReference: string
  role?: 'space' | 'chart'
}) {
  const comparison = useViewerComparison()
  const sceneOnly = useContext(ViewerSceneOnly)
  const comparing = Boolean(comparison)
  const sharedItem = role === 'space' ? `${name}@output-chart` : undefined
  const surfacePower = leaf.boxGrid.sampling === 'surface-integral'
  const sourceSampled = leaf.boxGrid.frequencyKind === 'source-sampled'
  const [wavelengthDisplay, setWavelengthDisplay] = useViewerSetting(
    'box.wavelength',
    true,
    'item',
    undefined,
    sharedItem,
  )
  const labels = surfacePower ? { ...axisLabels, x: 'u', y: 'v', frequency: '입력 파장 / 주파수' } : axisLabels
  const longest = useMemo(
    () =>
      [...projectionAxes].sort(
        (a, b) =>
          leaf.shape[projectionAxes.indexOf(b)] - leaf.shape[projectionAxes.indexOf(a)] ||
          projectionAxes.indexOf(a) - projectionAxes.indexOf(b),
      ),
    [leaf],
  )
  const chartAxes = useMemo<ProjectionAxis[]>(() => [longest[1], longest[0]], [longest])
  const [storedAxes, setAxes] = useViewerSetting<ProjectionAxis[]>(
    'box.axes',
    role === 'chart' ? chartAxes : surfacePower ? ['y', 'x'] : ['x', 'y', 'z'],
    'item',
    (value) =>
      role !== 'chart' ||
      (value.length >= 1 &&
        value.length <= 2 &&
        new Set(value).size === value.length &&
        value.every((axis) => projectionAxes.includes(axis))),
  )
  const [storedKind, setKind] = useViewerSetting<PlotKind>(
    'box.kind',
    role === 'chart' ? (storedAxes.length === 1 ? 'line' : 'heatmap') : surfacePower ? 'heatmap' : 'cloud',
    'item',
    (value) =>
      value !== 'histogram' &&
      (role !== 'chart' || value === 'line' || (value === 'heatmap' && storedAxes.length === 2)),
  )
  const [squarePixels, setSquarePixels] = useViewerSetting('box.squarePixels', true, 'item', undefined, sharedItem)
  const spatialAxes = positionAxes
  const spaceKind = spatialAxes.length === 3 ? 'cloud' : 'heatmap'
  const kind = role === 'space' ? spaceKind : storedKind
  const axes = useMemo<ProjectionAxis[]>(
    () => (role === 'space' ? spatialAxes : storedAxes),
    [role, storedAxes, spatialAxes],
  )
  const [representation, setRepresentation] = useViewerSetting<'amplitude' | 'phase'>(
    'box.representation',
    'amplitude',
    'item',
    undefined,
    sharedItem,
  )
  const vectorComponents = boxGridVectorComponents(leaf)
  const tensorComponents = boxGridTensorComponents(leaf)
  const [component, setComponent] = useViewerSetting<BoxGridComponentChoice>(
    'box.component',
    leaf.shape[6] === 1 ? 0 : vectorComponents ? 'arrows' : tensorComponents ? { tensor: ['all', 'all'] } : 'magnitude',
    'item',
    (value) =>
      typeof value === 'number'
        ? value < leaf.shape[6]
        : typeof value === 'object'
          ? !!tensorComponents
          : value === 'arrows' || value === 'magnitudeSquared'
            ? !!vectorComponents
            : true,
    sharedItem,
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
    sharedItem,
  )
  const [geometryOpacity] = useViewerSetting('geometryMode', 0.9, 'workspace')
  const [storedAnimation, setAnimation] = useViewerSetting<BoxGridAnimation>(
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
    sharedItem,
  )
  const chartSpatialAnimation = role === 'space' && ['x', 'y', 'z'].includes(storedAnimation)
  const animation = chartSpatialAnimation ? 'off' : storedAnimation
  const animationAxis = animation === 'off' || animation === 'oscillation' ? undefined : animation
  const animationLength = animationAxis
    ? leaf.shape[animationAxis === 'component' ? 6 : projectionAxes.indexOf(animationAxis)]
    : 1
  const [timeSeconds, setTimeSeconds] = useViewerSetting('box.timeSeconds', 0, 'item', undefined, sharedItem),
    [frameIndex, setFrameIndex] = useViewerSetting(
      'box.frameIndex',
      0,
      'item',
      (value) => !animationAxis || chartSpatialAnimation || value < animationLength,
      sharedItem,
    )
  const [durationOverride, setDurationOverride] = useViewerSetting<number | null>(
    'box.durationSeconds',
    null,
    'item',
    undefined,
    sharedItem,
  )
  const [playing, setPlaying] = useViewerSetting('box.playing', false, 'item', undefined, sharedItem),
    [repeat, setRepeat] = useViewerSetting('box.repeat', true, 'item', undefined, sharedItem),
    [speed, setSpeed] = useViewerSetting('box.speed', 1, 'item', undefined, sharedItem)
  const [fixed, setFixed] = useViewerSetting<readonly [number, number] | null>(
    'box.fixed',
    null,
    'item',
    undefined,
    sharedItem,
  )
  const [result, setResult] = useState<ReturnType<typeof calculateBoxGridView>>()
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('')
  const [renderError, setRenderError] = useState('')
  const rangeCache = useRef<{ key: string; value: [number, number]; distribution?: [number, number] } | null>(null)
  const spatial = axes.every((axis) => ['x', 'y', 'z'].includes(axis))
  const arrowComponents = useMemo(() => boxGridArrowComponents(leaf, component), [leaf, component])
  const arrowsAllowed =
    role !== 'chart' && kind === 'cloud' && spatial && !!arrowComponents && representation !== 'phase'
  const actualComponent =
    animation === 'component'
      ? frameIndex
      : component === 'arrows'
        ? 'magnitude'
        : component === 'magnitude' && tensorComponents
          ? { tensor: ['all', 'all'] as const }
          : typeof component === 'object'
            ? {
                tensor: component.tensor.map((direction) => (direction === 'arrows' ? 'all' : direction)) as [
                  'x' | 'y' | 'z' | 'all',
                  'x' | 'y' | 'z' | 'all',
                ],
              }
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
  const requestKey = `${optionKey}:${arrowsAllowed}`
  const [completedKey, setCompletedKey] = useState('')
  const viewKey = `${rangeKey}:${arrowsAllowed}`
  const [completedView, setCompletedView] = useState<{ leaf: CalculationInputLeaf; key: string }>()
  const frameUpdate = animation !== 'off' && result && completedView?.leaf === leaf && completedView.key === viewKey
  const showCalculationStatus = busy && !frameUpdate
  const invalidSetting =
    role === 'space' &&
    (spatialAxes.length < 2 ||
      (spatialAxes.length === 2 &&
        projectionAxes.slice(0, 3).some((axis, index) => !spatialAxes.includes(axis) && leaf.shape[index] !== 1)))
      ? 'XYZ 좌표 또는 평면 배치 정보가 없어 상단에 표시할 수 없습니다.'
      : animation === 'oscillation' && oscillationError
        ? oscillationError
        : comparison &&
            ((typeof component === 'number' &&
              (!Number.isInteger(component) || component < 0 || component >= leaf.shape[6])) ||
              (representation === 'phase' && leaf.shape[5] !== 2) ||
              (typeof component === 'object' && !tensorComponents) ||
              (representation === 'phase' && typeof component !== 'number') ||
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
      arrows: arrowsAllowed,
      vectorComponents: arrowsAllowed ? arrowComponents : undefined,
      animationRange: animation !== 'off' && rangeCache.current?.key !== rangeKey,
      sweepAxis: animationAxis,
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
    arrowComponents,
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
      role === 'space' ||
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
    role,
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
      role === 'chart' ||
      !result ||
      result.scalar.axes.map((axis) => axis.name).join(',') !== axesKey ||
      kind === 'line'
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
        vectors: arrowsAllowed ? result.vectors : undefined,
        plane,
        range,
      },
    )
  }, [
    role,
    result,
    kind,
    axes,
    effectiveReduce,
    leaf,
    name,
    spatial,
    displayUnit,
    arrowsAllowed,
    range,
    axesKey,
    sourceSampled,
    wavelengthDisplay,
    surfacePower,
  ])
  const unit =
    animation !== 'oscillation' && representation === 'phase'
      ? 'rad'
      : actualComponent === 'magnitudeSquared' && leaf.unit
        ? `(${leaf.unit})²`
        : leaf.unit
  const componentLabel =
    typeof actualComponent === 'number'
      ? leaf.boxGrid.components[actualComponent]
      : actualComponent === 'magnitude'
        ? '|V|'
        : actualComponent === 'magnitudeSquared'
          ? '|V|²'
          : actualComponent.tensor.every((direction) => direction !== 'all')
            ? `T${actualComponent.tensor.join('')}`
            : actualComponent.tensor.every((direction) => direction === 'all')
              ? '|T|'
              : `|T${actualComponent.tensor.map((direction) => (direction === 'all' ? ':' : direction)).join('')}|`
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
    if (role === 'chart') {
      if (next === 'heatmap' && axes.length === 1) setAxes([longest.find((axis) => axis !== axes[0])!, axes[0]])
      return
    }
    const count = next === 'cloud' ? 3 : next === 'heatmap' ? 2 : Math.min(2, Math.max(1, axes.length))
    const selected = [...new Set([...axes, ...longest])].slice(0, count)
    const ordered = projectionAxes.filter((axis) => selected.includes(axis))
    setAxes(next === 'heatmap' || (next === 'line' && count === 2) ? [...ordered].reverse() : ordered)
  }
  const changeRole = (axis: ProjectionAxis, reductionRole: 'space' | ProjectionReduction['method']) => {
    stopAnimation()
    if (role === 'chart') {
      if (reductionRole !== 'space')
        setReduce((current) => ({ ...current, [axis]: { method: reductionRole, index: 0 } }))
      setFixed(null)
      return
    }
    const selected = reductionRole === 'space' ? [...new Set([...axes, axis])] : axes.filter((item) => item !== axis)
    if (selected.length === 0 || selected.length > 3) return
    const ordered = projectionAxes.filter((item) => selected.includes(item))
    if (selected.length !== axes.length) {
      const nextKind = selected.length === 3 ? 'cloud' : selected.length === 2 ? 'heatmap' : 'line'
      setKind(nextKind)
      setAxes(nextKind === 'heatmap' ? [...ordered].reverse() : ordered)
      setResult(undefined)
    }
    if (reductionRole !== 'space') setReduce((current) => ({ ...current, [axis]: { method: reductionRole, index: 0 } }))
    setFixed(null)
  }
  const changeAxes = (next: ProjectionAxis[]) => {
    stopAnimation()
    setAxes(next)
    setResult(undefined)
    setFixed(null)
  }
  const ready =
    ((!busy && completedKey === requestKey) || frameUpdate) &&
    !error &&
    !invalidSetting &&
    !name.startsWith('@visualizations.')
  const controlsOwner = role !== 'space' && (!comparison || comparison.controlsOwner)
  const seekOscillation = (time: number) => {
    setPlaying(false)
    if (animation !== 'oscillation') stopAnimation()
    setRepresentation('amplitude')
    setAnimation('oscillation')
    setTimeSeconds(time)
  }
  const timeIndex = animation === 'time' ? frameIndex : (reduce.time?.index ?? 0)
  const seekTime = (index: number) => {
    stopAnimation()
    setAnimation('time')
    setFrameIndex(index)
  }
  const playbackCommon = {
    repeat,
    speed,
    onRepeat: setRepeat,
    onSpeed: setSpeed,
    pause: () => setPlaying(false),
    error: error || invalidSetting,
  }
  const playbackSources: ViewerPlaybackSource[] = []
  if (leaf.shape[3] > 1)
    playbackSources.push({
      ...playbackCommon,
      id: `box:${name}:time`,
      label: `${name} · t축`,
      disabled: axes.includes('time') ? 't가 차트 표시 축입니다' : undefined,
      preferred: animation === 'time',
      playing: playing && animation === 'time',
      position: timeIndex,
      minimum: 0,
      maximum: leaf.shape[3] - 1,
      step: 1,
      positionLabel: `${String(leaf.axes[3].ticks[timeIndex] ?? timeIndex)} ${leaf.axes[3].unit ?? ''} · ${timeIndex + 1}/${leaf.shape[3]}`,
      seek: seekTime,
      previous: () => seekTime(Math.max(0, timeIndex - 1)),
      next: () => seekTime(Math.min(leaf.shape[3] - 1, timeIndex + 1)),
      play: () => {
        seekTime(timeIndex >= leaf.shape[3] - 1 ? 0 : timeIndex)
        setPlaying(true)
      },
    })
  if (leaf.shape[5] === 2)
    playbackSources.push({
      ...playbackCommon,
      id: `box:${name}:oscillation`,
      label: `${name} · 진폭·위상 시간 전개`,
      error: oscillationError || playbackCommon.error,
      preferred: animation === 'oscillation',
      playing: playing && animation === 'oscillation',
      position: timeSeconds,
      minimum: 0,
      maximum: durationSeconds,
      step: 'any',
      positionLabel: `${timeSeconds.toExponential(5)} s`,
      duration: durationSeconds,
      onDuration: (duration) => {
        setPlaying(false)
        setTimeSeconds(0)
        setDurationOverride(duration)
      },
      seek: seekOscillation,
      previous: () => seekOscillation(Math.max(0, timeSeconds - timeStep)),
      next: () => seekOscillation(Math.min(durationSeconds, timeSeconds + timeStep)),
      play: () => {
        seekOscillation(timeSeconds >= durationSeconds ? 0 : timeSeconds)
        setPlaying(true)
      },
    })
  return (
    <div className={sceneOnly ? 'contents' : 'flex h-full min-h-0 flex-col overflow-hidden bg-white'}>
      {controlsOwner ? (
        <>
          <ViewerPlaybackRegistration sources={playbackSources} />
          <ViewerControls placement="actions">
            <ViewerToolButton
              label="변환 코드 복사"
              disabled={!ready}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    projectionCode(recordReference, options, arrowsAllowed ? arrowComponents : undefined),
                  )
                  toast.success('Calculation 변환식을 복사했습니다.')
                } catch {
                  toast.error('클립보드에 복사하지 못했습니다.')
                }
              }}
            >
              <Copy />
            </ViewerToolButton>
          </ViewerControls>
          <BoxGridOutputSettings
            leaf={leaf}
            mode={role}
            kind={kind}
            squarePixels={squarePixels}
            axes={axes}
            reduce={effectiveReduce}
            representation={representation}
            component={animation === 'component' ? frameIndex : component}
            onKind={changeKind}
            onSquarePixels={setSquarePixels}
            onAxes={changeAxes}
            onRole={changeRole}
            onRepresentation={(next) => {
              stopAnimation()
              setRepresentation(next)
              if (next === 'phase') setComponent(0)
              setFixed(null)
            }}
            onComponent={(next) => {
              setPlaying(false)
              if (animation !== 'oscillation') stopAnimation()
              setComponent(next)
              setFixed(null)
            }}
            onIndex={(axis, index) => {
              stopAnimation()
              setReduce((current) => ({ ...current, [axis]: { method: 'index', index } }))
            }}
            fixed={fixed}
            range={range}
            onFixed={setFixed}
            wavelengthDisplay={wavelengthDisplay}
            onWavelength={setWavelengthDisplay}
            animation={animation}
            timeSeconds={timeSeconds}
            durationSeconds={durationSeconds}
            oscillationError={oscillationError}
            onTime={seekOscillation}
          />
        </>
      ) : null}
      {!sceneOnly ? (
        <div className="flex shrink-0 flex-wrap items-center gap-3 px-3 py-2 text-xs text-slate-600" role="status">
          <strong>{name}</strong>
          {surfacePower ? (
            <span>
              픽셀 적분 전력 [W] · 기하광학 응답
              {role !== 'chart' ? (
                <>
                  {' · '}
                  {(['x', 'y', 'z'] as const)
                    .filter((axis) => !axes.includes(axis))
                    .map((axis) => `${labels[axis]} ${reduce[axis]?.method ?? 'mean'}`)
                    .join(' · ')}
                </>
              ) : null}
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
            · {componentLabel} [{unit}]
          </span>
          {role === 'chart' ? (
            <span aria-label="차트 축 설정" className="flex flex-wrap gap-x-3 gap-y-1">
              {projectionAxes
                .filter((axis) => !axes.includes(axis))
                .map((axis) => {
                  const reduction = effectiveReduce[axis]
                  const method = reduction?.method ?? 'mean'
                  const index = reduction?.index ?? 0
                  const dimension = leaf.axes[projectionAxes.indexOf(axis)]
                  return (
                    <span key={axis}>
                      {labels[axis]} ·{' '}
                      {method === 'index'
                        ? `개별 index ${index} · ${String(dimension.ticks[index] ?? '현재 데이터 범위 밖')} ${dimension.unit ?? ''}`
                        : method}
                    </span>
                  )
                })}
            </span>
          ) : null}
          <span
            aria-hidden={!showCalculationStatus}
            className={`shrink-0 whitespace-nowrap ${showCalculationStatus ? '' : 'invisible'}`}
          >
            계산 중…
          </span>
        </div>
      ) : showCalculationStatus ? (
        <p role="status" className="p-2 text-xs">
          계산 중…
        </p>
      ) : null}
      {invalidSetting || error || renderError || range[0] > range[1] ? (
        <p role="alert" className="p-3 text-red-700">
          {invalidSetting || error || renderError || '범위 최솟값은 최댓값 이하여야 합니다.'}
        </p>
      ) : null}
      <div className={sceneOnly ? 'contents' : 'min-h-0 flex-1'} aria-busy={busy}>
        {result && !invalidSetting && range[0] <= range[1] ? (
          role !== 'chart' && (kind === 'cloud' || (kind === 'heatmap' && spatial && canOverlayGeometry)) ? (
            renderData ? (
              <div className={sceneOnly ? 'contents' : 'flex h-full min-h-0 flex-col'}>
                <div className={sceneOnly ? 'contents' : 'min-h-0 flex-1'}>
                  {spatial && canOverlayGeometry ? (
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
          ) : !sceneOnly ? (
            <ScalarPlot
              plot={opticalPlotData(
                result.distribution ?? result.scalar,
                sourceSampled && wavelengthDisplay,
                surfacePower,
              )}
              kind={kind === 'cloud' ? 'heatmap' : kind}
              squarePixels={squarePixels}
              range={range}
              unit={unit}
              lockHistogramRange={animation !== 'off'}
            />
          ) : null
        ) : null}
      </div>
    </div>
  )
}
