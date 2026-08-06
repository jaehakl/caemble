import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import * as reglRenderer from '@jscad/regl-renderer'
import type { CadDocumentType, CadScenePart, RecordedDataRule, UcumUnit } from '@/lib/cad'
import { materialColor, unassignedGeometryColor } from './materialColor'
import RecordedDataResults from './RecordedDataResults'
import type { CadViewerRecordedData, RecordedDataDisplayUnits } from './recordedData'
import type { CadViewerSimulation } from './CadViewer'
import type { MaterialGridResult, MaterialGridWorkerRequest, MaterialGridWorkerResponse } from './materialGrid'
import { createWireframeGeometries } from './renderParts'
import {
  createLayerRenderParts,
  materialGridPartsFromLayers,
  scaleViewerLayers,
  type JscadViewerLayer,
} from './sourceLayers'

type RendererEntity = Record<string, unknown>
type RendererEntityCacheEntry = Readonly<{
  geometryEntities: RendererEntity[]
  wireframeEntities: RendererEntity[]
}>
type RendererOptions = Record<string, unknown> & {
  camera?: RendererState
  entities?: RendererEntity[]
}
type RendererState = Record<string, unknown>
type RendererChange = {
  camera: RendererState
  controls: RendererState
}
type ReglRendererApi = {
  cameras: {
    perspective: {
      defaults: RendererState
      setProjection: (
        output: RendererState,
        camera: RendererState,
        input: { height: number; width: number },
      ) => RendererState
      update: (output: RendererState, camera: RendererState) => RendererState
    }
  }
  controls: {
    orbit: {
      defaults: RendererState
      pan: (
        state: RendererState & { camera: RendererState; controls: RendererState; speed: number },
        delta: number[],
      ) => RendererChange
      rotate: (
        state: RendererState & { camera: RendererState; controls: RendererState; speed: number },
        angle: number[],
      ) => RendererChange
      update: (state: { camera: RendererState; controls: RendererState }) => RendererChange
      zoom: (
        state: RendererState & { camera: RendererState; controls: RendererState; speed: number },
        delta: number,
      ) => RendererChange
      zoomToFit: (state: {
        camera: RendererState
        controls: RendererState
        entities: RendererEntity[]
      }) => RendererChange
    }
  }
  drawCommands: Record<string, unknown>
  entitiesFromSolids: (options: Record<string, unknown>, ...solids: unknown[]) => RendererEntity[]
  prepareRender: (options: RendererOptions) => (options: RendererOptions) => void
}

type ReglBuffer = (data: unknown) => void
type ReglCommand = (props: RendererEntity) => void
type ReglApi = {
  (options: Record<string, unknown>): ReglCommand
  buffer: (data: unknown) => ReglBuffer
}

type PointGeometry = Readonly<{
  colors: Float32Array
  positions: Float32Array
}>

export type ViewerMode = 'geometry' | 'material-grid' | 'results'
type CameraView = 'default' | 'x' | 'y' | 'z'
type MaterialGridStatus = 'idle' | 'calculating' | 'ready' | 'error'

type MaterialGridSnapshot = Readonly<{
  parts: CadScenePart[]
  requestedSpacing: number
  result: MaterialGridResult
}>

type JscadViewerProps = {
  availableSources?: readonly CadDocumentType[]
  emptyMessage?: string
  layers: readonly JscadViewerLayer[]
  lengthUnit: UcumUnit
  onRenderEnd: () => void
  onRenderError: (message: string) => void
  onRenderStart: () => void
  onToggleSource?: (documentType: CadDocumentType) => void
  recordedData?: CadViewerRecordedData | null
  recordedDataRules?: readonly RecordedDataRule[]
  resultsLayout?: 'split' | 'tabs'
  simulation?: CadViewerSimulation | null
  visibleSources?: readonly CadDocumentType[]
}

type ViewerToolbarProps = {
  availableSources?: readonly CadDocumentType[]
  gridError: string | null
  gridResult: MaterialGridResult | null
  gridStatus: MaterialGridStatus
  hasResults?: boolean
  lengthUnit?: UcumUnit
  mode: ViewerMode
  onApplySpacing: () => void
  onChangeSpacing: (value: string) => void
  onSetCameraView: (view: CameraView) => void
  onSelectMode: (mode: ViewerMode) => void
  onToggleSource?: (documentType: CadDocumentType) => void
  spacingDraft: string
  spacingError: string | null
  simulation?: CadViewerSimulation | null
  visibleSources?: readonly CadDocumentType[]
}

const renderer = reglRenderer as unknown as ReglRendererApi
const materialGridTimeoutMs = 30_000
const defaultResultsSplitPercent = 50
const resultsSplitDividerWidth = 5
const resultsSplitMinimumPanelWidth = 320
const resultsSplitMinimumViewerWidth = 720
const cameraViewDirections = {
  default: [1, 1, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const
const solverCompatibilityLabels = Object.freeze({
  unavailable: 'Unavailable',
  checking: 'Checking',
  compatible: 'Compatible',
  incompatible: 'Incompatible',
})

function formatSpacing(value: number) {
  return Number(value.toPrecision(6)).toString()
}

function clampResultsSplitPercent(percent: number, viewerWidth: number) {
  const availableWidth = viewerWidth - resultsSplitDividerWidth
  if (availableWidth < resultsSplitMinimumPanelWidth * 2) return defaultResultsSplitPercent
  const minimum = (resultsSplitMinimumPanelWidth / availableWidth) * 100
  return Math.min(100 - minimum, Math.max(minimum, percent))
}

function drawPoints(regl: unknown, params: RendererEntity) {
  const typedRegl = regl as ReglApi
  const initialGeometry = params.geometry as PointGeometry
  const positionBuffer = typedRegl.buffer(initialGeometry.positions)
  const colorBuffer = typedRegl.buffer(initialGeometry.colors)
  let renderedGeometry = initialGeometry
  const command = typedRegl({
    attributes: {
      color: colorBuffer,
      position: positionBuffer,
    },
    count: (_context: unknown, props: RendererEntity) => props.pointCount,
    cull: { enable: false },
    depth: { enable: true },
    frag: `
      precision mediump float;
      varying vec4 pointColor;

      void main() {
        if (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;
        gl_FragColor = pointColor;
      }
    `,
    primitive: 'points',
    uniforms: {
      pointSize: (_context: unknown, props: RendererEntity) => props.pointSize,
    },
    vert: `
      precision mediump float;
      attribute vec3 position;
      attribute vec4 color;
      uniform mat4 view, projection;
      uniform float pointSize;
      varying vec4 pointColor;

      void main() {
        pointColor = color;
        gl_Position = projection * view * vec4(position, 1.0);
        gl_PointSize = pointSize;
      }
    `,
  })

  return (props: RendererEntity) => {
    const geometry = props.geometry as PointGeometry
    if (geometry !== renderedGeometry) {
      positionBuffer(geometry.positions)
      colorBuffer(geometry.colors)
      renderedGeometry = geometry
    }
    command({ ...props, pointCount: geometry.positions.length / 3 })
  }
}

export function ViewerToolbar({
  availableSources = [],
  gridError,
  gridResult,
  gridStatus,
  hasResults = false,
  lengthUnit = 'm',
  mode,
  onApplySpacing,
  onChangeSpacing,
  onSetCameraView,
  onSelectMode,
  onToggleSource,
  spacingDraft,
  spacingError,
  simulation,
  visibleSources = [],
}: ViewerToolbarProps) {
  const appliedSpacingChanged = gridResult && gridResult.effectiveSpacing !== gridResult.requestedSpacing
  const firstCompatibilityIssue = simulation?.compatibility.issues[0]
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const modes: ViewerMode[] = hasResults ? ['geometry', 'material-grid', 'results'] : ['geometry', 'material-grid']
    const currentIndex = modes.indexOf(mode)
    const targetMode =
      event.key === 'Home'
        ? modes[0]
        : event.key === 'End'
          ? modes[modes.length - 1]
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? modes[(currentIndex - 1 + modes.length) % modes.length]
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? modes[(currentIndex + 1) % modes.length]
              : undefined
    if (!targetMode) return

    event.preventDefault()
    onSelectMode(targetMode)
    document.getElementById(`viewer-${targetMode}-tab`)?.focus()
  }

  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-2 py-1">
      <div aria-label="Viewer modes" className="flex h-9 items-center" role="tablist">
        <button
          aria-controls="viewer-render-panel"
          aria-selected={mode === 'geometry'}
          className={`h-full border-b-2 px-3 text-xs font-semibold tracking-wide uppercase ${
            mode === 'geometry'
              ? 'border-slate-900 text-slate-950'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
          id="viewer-geometry-tab"
          role="tab"
          tabIndex={mode === 'geometry' ? 0 : -1}
          type="button"
          onClick={() => onSelectMode('geometry')}
          onKeyDown={handleTabKeyDown}
        >
          Geometry
        </button>
        <button
          aria-controls="viewer-render-panel"
          aria-selected={mode === 'material-grid'}
          className={`h-full border-b-2 px-3 text-xs font-semibold tracking-wide uppercase ${
            mode === 'material-grid'
              ? 'border-slate-900 text-slate-950'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
          id="viewer-material-grid-tab"
          role="tab"
          tabIndex={mode === 'material-grid' ? 0 : -1}
          type="button"
          onClick={() => onSelectMode('material-grid')}
          onKeyDown={handleTabKeyDown}
        >
          Material Grid
        </button>
        {hasResults ? (
          <button
            aria-controls="viewer-render-panel"
            aria-selected={mode === 'results'}
            className={`h-full border-b-2 px-3 text-xs font-semibold tracking-wide uppercase ${
              mode === 'results'
                ? 'border-slate-900 text-slate-950'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
            id="viewer-results-tab"
            role="tab"
            tabIndex={mode === 'results' ? 0 : -1}
            type="button"
            onClick={() => onSelectMode('results')}
            onKeyDown={handleTabKeyDown}
          >
            Results
          </button>
        ) : null}
      </div>

      {mode !== 'results' ? (
        <div aria-label="Camera views" className="flex items-center gap-1 border-l border-slate-200 pl-3">
          {(['default', 'x', 'y', 'z'] as const).map((view) => (
            <button
              aria-label={`Set ${view} camera view`}
              className="min-w-7 rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950"
              key={view}
              type="button"
              onClick={() => onSetCameraView(view)}
            >
              {view === 'default' ? 'Default' : view.toUpperCase()}
            </button>
          ))}
        </div>
      ) : null}

      {onToggleSource && mode !== 'results' ? (
        <div aria-label="Viewer sources" className="flex items-center gap-1 border-l border-slate-200 pl-3">
          {(['structure', 'experiment'] as const).map((documentType) => {
            const available = availableSources.includes(documentType)
            const visible = visibleSources.includes(documentType)
            return (
              <button
                aria-label={`Toggle ${documentType}`}
                aria-pressed={available && visible}
                className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                  available && visible
                    ? 'border-slate-400 bg-slate-100 text-slate-900'
                    : 'border-slate-200 bg-white text-slate-400'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                disabled={!available}
                key={documentType}
                type="button"
                onClick={() => onToggleSource(documentType)}
              >
                {documentType === 'structure' ? 'Structure' : 'Experiment'}
              </button>
            )
          })}
        </div>
      ) : null}

      {mode === 'material-grid' ? (
        <>
          <form
            className="ml-auto flex items-center gap-1.5"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              onApplySpacing()
            }}
          >
            <label className="text-xs font-medium text-slate-600" htmlFor="material-grid-spacing">
              Spacing ({lengthUnit})
            </label>
            <input
              aria-describedby={spacingError ? 'material-grid-spacing-error' : undefined}
              aria-invalid={spacingError ? true : undefined}
              className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-right text-xs text-slate-800 outline-none focus:border-slate-500"
              id="material-grid-spacing"
              inputMode="decimal"
              min="0"
              step="any"
              type="number"
              value={spacingDraft}
              onChange={(event) => onChangeSpacing(event.target.value)}
            />
            <button
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950"
              type="submit"
            >
              Apply
            </button>
          </form>

          <div aria-live="polite" className="text-[10px] text-slate-500">
            {gridStatus === 'calculating' ? 'Calculating grid…' : null}
            {gridStatus === 'ready' && gridResult ? (
              <>
                {gridResult.visiblePointCount} points ·{' '}
                {appliedSpacingChanged
                  ? `requested ${formatSpacing(gridResult.requestedSpacing)} ${lengthUnit} · applied ${formatSpacing(gridResult.effectiveSpacing)} ${lengthUnit}`
                  : `spacing ${formatSpacing(gridResult.effectiveSpacing)} ${lengthUnit}`}
              </>
            ) : null}
          </div>

          {spacingError ? (
            <div className="w-full pl-1 text-[10px] text-rose-600" id="material-grid-spacing-error" role="alert">
              {spacingError}
            </div>
          ) : null}
          {gridError ? (
            <div className="w-full pl-1 text-[10px] text-rose-600" role="alert">
              {gridError}
            </div>
          ) : null}
        </>
      ) : null}

      {simulation ? (
        <div
          aria-label="Simulation controls"
          className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 border-l border-slate-200 pl-3 text-xs"
        >
          <span
            className="max-w-52 truncate font-mono text-[11px] text-slate-600"
            title={
              simulation.process.engine
                ? `${simulation.process.engine.name}@${simulation.process.engine.version}`
                : 'Simulation program'
            }
          >
            {simulation.process.engine
              ? `${simulation.process.engine.name}@${simulation.process.engine.version}`
              : 'Simulation program'}
          </span>
          <span
            aria-label={`Solver compatibility: ${simulation.compatibility.status}`}
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
              simulation.compatibility.status === 'compatible'
                ? 'bg-emerald-100 text-emerald-700'
                : simulation.compatibility.status === 'incompatible'
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-slate-100 text-slate-600'
            }`}
            title={
              firstCompatibilityIssue
                ? `${firstCompatibilityIssue.path}: ${firstCompatibilityIssue.message}`
                : undefined
            }
          >
            {solverCompatibilityLabels[simulation.compatibility.status]}
            {simulation.compatibility.status === 'incompatible' ? ` · ${simulation.compatibility.issues.length}` : ''}
          </span>
          <span
            aria-label={`Simulation status: ${simulation.process.status}`}
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
              simulation.process.status === 'failed'
                ? 'bg-rose-100 text-rose-700'
                : simulation.process.status === 'succeeded'
                  ? 'bg-emerald-100 text-emerald-700'
                  : simulation.process.status === 'preparing' || simulation.process.status === 'running'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-slate-100 text-slate-600'
            }`}
          >
            {simulation.process.status}
            {simulation.process.stage ? ` · ${simulation.process.stage}` : ''}
          </span>
          {simulation.stale ? (
            <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-orange-700 uppercase">
              Stale
            </span>
          ) : null}
          {simulation.process.status === 'preparing' || simulation.process.status === 'running' ? (
            <button
              aria-label="Cancel simulation"
              className="rounded border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 shadow-sm hover:border-rose-400 hover:text-rose-900"
              type="button"
              onClick={simulation.cancel}
            >
              Cancel
            </button>
          ) : (
            <button
              aria-describedby={
                simulation.compatibility.status === 'incompatible' ? 'simulation-compatibility-message' : undefined
              }
              aria-label="Run simulation"
              className="rounded border border-slate-300 bg-slate-900 px-2.5 py-1 text-xs font-medium text-white shadow-sm hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={!simulation.canRun}
              title={
                simulation.compatibility.status === 'incompatible'
                  ? `Resolve ${simulation.compatibility.issues.length} compatibility issue${simulation.compatibility.issues.length === 1 ? '' : 's'} in Kernel Spec before running.`
                  : undefined
              }
              type="button"
              onClick={simulation.run}
            >
              Run Simulation
            </button>
          )}
          {simulation.compatibility.status === 'incompatible' ? (
            <div
              className="max-h-16 w-full max-w-3xl overflow-auto text-right text-[10px] leading-4 text-amber-800"
              id="simulation-compatibility-message"
              role="status"
            >
              Simulation incompatible · {simulation.compatibility.issues.length} issue
              {simulation.compatibility.issues.length === 1 ? '' : 's'}
              {firstCompatibilityIssue
                ? ` · ${firstCompatibilityIssue.path}: ${firstCompatibilityIssue.message}`
                : ''}{' '}
              · See Kernel Spec.
            </div>
          ) : null}
          {simulation.process.error ? (
            <div className="max-h-16 w-full overflow-auto text-right text-[10px] text-rose-600" role="alert">
              {simulation.process.error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function JscadViewer({
  availableSources,
  emptyMessage = 'Waiting for model...',
  layers,
  lengthUnit,
  onRenderEnd,
  onRenderError,
  onRenderStart,
  onToggleSource,
  recordedData,
  recordedDataRules = [],
  resultsLayout = 'tabs',
  simulation,
  visibleSources,
}: JscadViewerProps) {
  const displayLayers = useMemo(() => scaleViewerLayers(layers, lengthUnit), [layers, lengthUnit])
  const parts = useMemo(() => materialGridPartsFromLayers(displayLayers), [displayLayers])
  const recordedDataSchemaSignature = useMemo(
    () =>
      JSON.stringify(
        recordedDataRules.map((rule) => ({
          label: rule.label,
          result: {
            axes: rule.result.axes?.map((axis) => ({
              length: axis.length,
              name: axis.name,
              quantityKind: axis.quantityKind,
              ticks: axis.ticks,
              unit: axis.unit,
            })),
            dtype: rule.result.dtype,
            quantityKind: rule.result.quantityKind,
            basis: rule.result.basis,
            unit: rule.result.unit,
          },
        })),
      ),
    [recordedDataRules],
  )
  const [gridError, setGridError] = useState<string | null>(null)
  const [gridApplyVersion, setGridApplyVersion] = useState(0)
  const [gridSnapshot, setGridSnapshot] = useState<MaterialGridSnapshot | null>(null)
  const [gridStatus, setGridStatus] = useState<MaterialGridStatus>('idle')
  const [requestedSpacing, setRequestedSpacing] = useState(1)
  const [spacingDraft, setSpacingDraft] = useState('1')
  const [spacingError, setSpacingError] = useState<string | null>(null)
  const [recordedDisplayUnits, setRecordedDisplayUnits] = useState<RecordedDataDisplayUnits>({})
  const [viewerMode, setViewerMode] = useState<ViewerMode>('geometry')
  const [viewerWidth, setViewerWidth] = useState(0)
  const [resultsSplitPercent, setResultsSplitPercent] = useState(defaultResultsSplitPercent)
  const activeGridRenderRef = useRef<Readonly<{ requestId: string; onRenderEnd: () => void }> | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<RendererState | null>(null)
  const controlsRef = useRef<RendererState | null>(null)
  const gridRequestSequenceRef = useRef(0)
  const gridSnapshotRef = useRef<MaterialGridSnapshot | null>(null)
  const gridWorkerRef = useRef<Worker | null>(null)
  const lastFittedPartsRef = useRef<CadScenePart[] | null>(null)
  const lastPointRef = useRef<{
    button: 0 | 2
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const lastRenderedModeRef = useRef<ViewerMode | null>(null)
  const optionsRef = useRef<RendererOptions | null>(null)
  const pointEntityRef = useRef<RendererEntity>({
    geometry: { colors: new Float32Array(), positions: new Float32Array() },
    pointSize: 5,
    visuals: { drawCmd: 'drawPoints', show: true },
  })
  const rendererEntityCacheRef = useRef(new Map<string, RendererEntityCacheEntry>())
  const recordedDataSchemaSignatureRef = useRef(recordedDataSchemaSignature)
  const renderCallbacksRef = useRef({ onRenderEnd, onRenderStart })
  const resultsSplitRef = useRef<HTMLDivElement | null>(null)
  const referenceEntitiesRef = useRef<RendererEntity[]>([
    {
      size: [120, 120],
      ticks: [10, 2],
      visuals: { drawCmd: 'drawGrid', show: true },
    },
    {
      size: 70,
      visuals: { drawCmd: 'drawAxis', show: true },
    },
  ])
  const renderRef = useRef<((options: RendererOptions) => void) | null>(null)
  const viewerRef = useRef<HTMLDivElement | null>(null)

  renderCallbacksRef.current = { onRenderEnd, onRenderStart }

  const currentGridResult =
    gridSnapshot?.parts === parts && gridSnapshot.requestedSpacing === requestedSpacing ? gridSnapshot.result : null
  const hasColoredGeometry = parts.some((part) => materialColor(part.material) !== undefined)
  const hasResults = recordedDataRules.length > 0
  const splitResults = resultsLayout === 'split' && hasResults && viewerWidth >= resultsSplitMinimumViewerWidth
  const activeViewerMode = splitResults && viewerMode === 'results' ? 'geometry' : viewerMode
  const availableSplitWidth = Math.max(1, viewerWidth - resultsSplitDividerWidth)
  const minimumSplitPercent = Math.min(
    defaultResultsSplitPercent,
    (resultsSplitMinimumPanelWidth / availableSplitWidth) * 100,
  )
  const maximumSplitPercent = 100 - minimumSplitPercent
  const geometryPanelWidth = (availableSplitWidth * resultsSplitPercent) / 100

  useEffect(() => {
    if (!hasResults && viewerMode === 'results') setViewerMode('geometry')
  }, [hasResults, viewerMode])

  useEffect(() => {
    if (splitResults && viewerMode === 'results') setViewerMode('geometry')
  }, [splitResults, viewerMode])

  useEffect(() => {
    if (resultsLayout !== 'split') {
      setViewerWidth(0)
      return
    }

    const viewer = viewerRef.current
    if (!viewer) return
    const updateWidth = () => setViewerWidth(viewer.getBoundingClientRect().width)
    const resizeObserver = new ResizeObserver(updateWidth)
    resizeObserver.observe(viewer)
    updateWidth()
    return () => resizeObserver.disconnect()
  }, [resultsLayout])

  useEffect(() => {
    if (!splitResults) return
    setResultsSplitPercent((current) => clampResultsSplitPercent(current, viewerWidth))
  }, [splitResults, viewerWidth])

  useEffect(() => {
    if (recordedDataSchemaSignatureRef.current === recordedDataSchemaSignature) return
    recordedDataSchemaSignatureRef.current = recordedDataSchemaSignature
    setRecordedDisplayUnits({})
  }, [recordedDataSchemaSignature])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const perspectiveCamera = renderer.cameras.perspective
    const orbit = renderer.controls.orbit
    const camera = Object.assign({}, perspectiveCamera.defaults)
    const initialPosition = camera.position as number[]
    const initialTarget = camera.target as number[]
    const initialDistance = Math.hypot(
      initialPosition[0] - initialTarget[0],
      initialPosition[1] - initialTarget[1],
      initialPosition[2] - initialTarget[2],
    )
    const defaultDirectionLength = Math.sqrt(3)
    camera.position = cameraViewDirections.default.map(
      (component) => (component / defaultDirectionLength) * initialDistance,
    )
    camera.target = [0, 0, 0]
    camera.up = [0, 0, 1]
    const controls = Object.assign({}, orbit.defaults, {
      autoRotate: { enabled: false, speed: 1 },
      userControl: {
        zoom: true,
        zoomSpeed: 1,
        rotate: true,
        rotateSpeed: 1,
        pan: true,
        panSpeed: 1,
      },
    })

    cameraRef.current = camera
    controlsRef.current = controls

    const options = {
      camera,
      drawCommands: {
        drawAxis: renderer.drawCommands.drawAxis,
        drawGrid: renderer.drawCommands.drawGrid,
        drawLines: renderer.drawCommands.drawLines,
        drawMesh: renderer.drawCommands.drawMesh,
        drawPoints,
      },
      entities: [],
      glOptions: { canvas },
      rendering: {
        background: [0.98, 0.99, 1, 1],
      },
    }

    optionsRef.current = options
    renderRef.current = renderer.prepareRender(options)

    const renderScene = () => {
      if (!renderRef.current || !optionsRef.current) return
      renderRef.current(optionsRef.current)
    }

    const wheelHandler = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()

      const controlChange = orbit.zoom({ camera, controls, speed: 0.12 }, event.deltaY > 0 ? 1 : -1)
      Object.assign(camera, controlChange.camera)
      Object.assign(controls, controlChange.controls)

      const updated = orbit.update({ camera, controls })
      Object.assign(camera, updated.camera)
      Object.assign(controls, updated.controls)
      perspectiveCamera.update(camera, camera)
      renderScene()
    }

    const resize = () => {
      const parent = canvas.parentElement
      const rect = parent?.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect?.width ?? canvas.clientWidth))
      const height = Math.max(1, Math.floor(rect?.height ?? canvas.clientHeight))
      const ratio = window.devicePixelRatio || 1

      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      perspectiveCamera.setProjection(camera, camera, {
        width: canvas.width,
        height: canvas.height,
      })
      perspectiveCamera.update(camera, camera)
      renderScene()
    }

    const resizeObserver = new ResizeObserver(resize)
    canvas.addEventListener('wheel', wheelHandler, { passive: false })
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement)
    resize()

    return () => {
      canvas.removeEventListener('wheel', wheelHandler)
      resizeObserver.disconnect()
      renderRef.current = null
      optionsRef.current = null
    }
  }, [])

  useEffect(() => {
    if (activeViewerMode !== 'material-grid' || parts.length === 0) return

    const cached = gridSnapshotRef.current
    const requestId = `material-grid-${gridRequestSequenceRef.current + 1}`
    gridRequestSequenceRef.current += 1
    activeGridRenderRef.current = { requestId, onRenderEnd: renderCallbacksRef.current.onRenderEnd }
    setGridError(null)
    renderCallbacksRef.current.onRenderStart()

    if (cached?.parts === parts && cached.requestedSpacing === requestedSpacing) {
      setGridStatus('ready')
      return
    }

    setGridStatus('calculating')
    let timeoutId: number | null = null
    const clearGridTimeout = () => {
      if (timeoutId === null) return
      window.clearTimeout(timeoutId)
      timeoutId = null
    }
    const finishWithError = (message: string) => {
      const activeRender = activeGridRenderRef.current
      if (activeRender?.requestId !== requestId) return
      clearGridTimeout()
      activeGridRenderRef.current = null
      setGridError(message)
      setGridStatus('error')
      activeRender.onRenderEnd()
    }

    let worker: Worker
    try {
      worker = new Worker(new URL('./materialGrid.worker.ts', import.meta.url), { type: 'module' })
      gridWorkerRef.current = worker
    } catch (error) {
      finishWithError(error instanceof Error ? error.message : String(error))
      return
    }

    timeoutId = window.setTimeout(() => {
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      finishWithError('Material Grid calculation timed out after 30 seconds. Try a larger spacing.')
    }, materialGridTimeoutMs)

    worker.onmessage = (event: MessageEvent<MaterialGridWorkerResponse>) => {
      const response = event.data
      if (response.requestId !== requestId) return

      clearGridTimeout()
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      if (response.type === 'error') {
        finishWithError(response.message)
        return
      }

      const snapshot = { parts, requestedSpacing, result: response.result }
      gridSnapshotRef.current = snapshot
      setGridSnapshot(snapshot)
      setGridStatus('ready')
    }

    worker.onerror = (event) => {
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      finishWithError(event.message || 'Material Grid calculation failed.')
    }

    worker.onmessageerror = () => {
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      finishWithError('Material Grid worker could not deserialize the calculation result.')
    }

    try {
      worker.postMessage({
        parts,
        requestId,
        requestedSpacing,
      } satisfies MaterialGridWorkerRequest)
    } catch (error) {
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      finishWithError(error instanceof Error ? error.message : String(error))
      return
    }

    return () => {
      clearGridTimeout()
      worker.terminate()
      if (gridWorkerRef.current === worker) gridWorkerRef.current = null
      const activeRender = activeGridRenderRef.current
      if (activeRender?.requestId === requestId) {
        activeGridRenderRef.current = null
        activeRender.onRenderEnd()
      }
    }
  }, [activeViewerMode, gridApplyVersion, parts, requestedSpacing])

  useEffect(() => {
    if (activeViewerMode === 'results') return
    if (parts.length === 0 || !optionsRef.current || !renderRef.current || !cameraRef.current || !controlsRef.current)
      return

    const shouldFit = lastFittedPartsRef.current !== parts
    const modeChanged = lastRenderedModeRef.current !== activeViewerMode
    const shouldReportGeometryRender = activeViewerMode === 'geometry' && (shouldFit || modeChanged)
    if (shouldReportGeometryRender) onRenderStart()

    try {
      const cacheKey = displayLayers.every((layer) => layer.sceneHash)
        ? JSON.stringify({
            lengthUnit,
            scenes: displayLayers.map((layer) => [
              layer.documentType,
              layer.sceneHash,
              layer.parts.map((part) => [part.id, part.material?.name ?? null, materialColor(part.material) ?? null]),
            ]),
          })
        : null
      const cachedEntities = cacheKey ? rendererEntityCacheRef.current.get(cacheKey) : undefined
      let geometryEntities = cachedEntities?.geometryEntities
      let wireframeEntities = cachedEntities?.wireframeEntities ?? []
      if (!geometryEntities) {
        const renderParts = createLayerRenderParts(displayLayers)
        wireframeEntities = renderParts
          .filter((part) => part.wireframe)
          .flatMap((part) =>
            createWireframeGeometries(part).map((geometry) => ({
              geometry,
              visuals: {
                drawCmd: 'drawLines',
                show: true,
                transparent: false,
                useVertexColors: true,
              },
            })),
          )
        const meshEntities = renderParts
          .filter((part) => !part.wireframe)
          .flatMap((part) => renderer.entitiesFromSolids({ color: part.color, smoothNormals: true }, part.geometry))
        geometryEntities = [...meshEntities, ...wireframeEntities]
        if (cacheKey) {
          rendererEntityCacheRef.current.set(cacheKey, { geometryEntities, wireframeEntities })
          if (rendererEntityCacheRef.current.size > 16) {
            rendererEntityCacheRef.current.delete(rendererEntityCacheRef.current.keys().next().value!)
          }
        }
      }
      const displayEntities =
        activeViewerMode === 'geometry'
          ? geometryEntities
          : [
              ...(currentGridResult
                ? [
                    Object.assign(pointEntityRef.current, {
                      geometry: {
                        colors: currentGridResult.colors,
                        positions: currentGridResult.positions,
                      },
                      pointSize: 5 * (window.devicePixelRatio || 1),
                    }),
                  ]
                : []),
              ...wireframeEntities,
            ]

      optionsRef.current.entities = [...referenceEntitiesRef.current, ...displayEntities]

      if (shouldFit) {
        const zoomed = renderer.controls.orbit.zoomToFit({
          camera: cameraRef.current,
          controls: controlsRef.current,
          entities: geometryEntities,
        })
        Object.assign(cameraRef.current, zoomed.camera)
        Object.assign(controlsRef.current, zoomed.controls)
      }

      const updated = renderer.controls.orbit.update({
        camera: cameraRef.current,
        controls: controlsRef.current,
      })
      Object.assign(cameraRef.current, updated.camera)
      Object.assign(controlsRef.current, updated.controls)
      renderer.cameras.perspective.update(cameraRef.current, cameraRef.current)

      renderRef.current(optionsRef.current)
      if (shouldFit) lastFittedPartsRef.current = parts
      lastRenderedModeRef.current = activeViewerMode

      if (shouldReportGeometryRender) onRenderEnd()
      if (activeViewerMode === 'material-grid' && currentGridResult && activeGridRenderRef.current !== null) {
        const activeRender = activeGridRenderRef.current
        activeGridRenderRef.current = null
        activeRender.onRenderEnd()
      }
    } catch (error) {
      activeGridRenderRef.current = null
      const typedError = error as { message?: string }
      onRenderError(typedError.message ?? String(error))
    }
  }, [
    currentGridResult,
    displayLayers,
    gridApplyVersion,
    lengthUnit,
    onRenderEnd,
    onRenderError,
    onRenderStart,
    parts,
    activeViewerMode,
  ])

  const renderWithControls = () => {
    if (!cameraRef.current || !controlsRef.current || !optionsRef.current || !renderRef.current) return

    const updated = renderer.controls.orbit.update({
      camera: cameraRef.current,
      controls: controlsRef.current,
    })
    Object.assign(cameraRef.current, updated.camera)
    Object.assign(controlsRef.current, updated.controls)
    renderer.cameras.perspective.update(cameraRef.current, cameraRef.current)
    renderRef.current(optionsRef.current)
  }

  const applySpacing = () => {
    const spacing = Number(spacingDraft)
    if (!Number.isFinite(spacing) || spacing <= 0) {
      setSpacingError('Enter a positive finite spacing value.')
      return
    }

    setSpacingError(null)
    setRequestedSpacing(spacing)
    setGridApplyVersion((current) => current + 1)
  }

  const setCameraView = (view: CameraView) => {
    if (!cameraRef.current || !controlsRef.current) return

    const position = cameraRef.current.position as number[]
    const target = cameraRef.current.target as number[]
    const currentDistance = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2])
    const fallbackPosition = renderer.cameras.perspective.defaults.position as number[]
    const fallbackTarget = renderer.cameras.perspective.defaults.target as number[]
    const fallbackDistance = Math.hypot(
      fallbackPosition[0] - fallbackTarget[0],
      fallbackPosition[1] - fallbackTarget[1],
      fallbackPosition[2] - fallbackTarget[2],
    )
    const distance = Number.isFinite(currentDistance) && currentDistance > 0 ? currentDistance : fallbackDistance
    const direction = cameraViewDirections[view]
    const directionLength = Math.hypot(...direction)

    Object.assign(cameraRef.current, {
      position: direction.map((component) => (component / directionLength) * distance),
      target: [0, 0, 0],
      up: view === 'z' ? [0, 1, 0] : [0, 0, 1],
    })
    Object.assign(controlsRef.current, {
      phiDelta: 0,
      scale: 1,
      thetaDelta: 0,
    })
    renderWithControls()
  }

  const resultsPanel = (
    <RecordedDataResults
      displayUnits={recordedDataSchemaSignatureRef.current === recordedDataSchemaSignature ? recordedDisplayUnits : {}}
      recordedData={recordedData}
      rules={recordedDataRules}
      onDisplayUnitChange={(label, target, unit) =>
        setRecordedDisplayUnits((current) => {
          const entry = current[label] ?? {}
          return {
            ...current,
            [label]:
              target === 'result' ? { ...entry, result: unit } : { ...entry, axes: { ...entry.axes, [target]: unit } },
          }
        })
      }
    />
  )

  const viewerPanel = (
    <div
      aria-labelledby={`viewer-${activeViewerMode}-tab`}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
      id="viewer-render-panel"
      role="tabpanel"
    >
      <canvas
        ref={canvasRef}
        className={`${activeViewerMode === 'results' ? 'hidden' : 'block'} h-full w-full cursor-grab touch-none active:cursor-grabbing`}
        data-viewer-canvas="true"
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (event.button !== 0 && event.button !== 2) return

          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          lastPointRef.current = {
            button: event.button,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          }
        }}
        onPointerMove={(event) => {
          const lastPoint = lastPointRef.current
          if (!lastPoint || lastPoint.pointerId !== event.pointerId) return

          const pressedButton = lastPoint.button === 2 ? 2 : 1
          if ((event.buttons & pressedButton) === 0) {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            lastPointRef.current = null
            return
          }
          if (!cameraRef.current || !controlsRef.current) return

          event.preventDefault()
          const dx = event.clientX - lastPoint.x
          const dy = event.clientY - lastPoint.y
          const controlChange =
            lastPoint.button === 2
              ? renderer.controls.orbit.pan({ camera: cameraRef.current, controls: controlsRef.current, speed: 1 }, [
                  -dx,
                  dy,
                ])
              : renderer.controls.orbit.rotate(
                  { camera: cameraRef.current, controls: controlsRef.current, speed: 0.006 },
                  [dx, dy],
                )

          Object.assign(cameraRef.current, controlChange.camera)
          Object.assign(controlsRef.current, controlChange.controls)
          lastPointRef.current = { ...lastPoint, x: event.clientX, y: event.clientY }
          renderWithControls()
        }}
        onPointerUp={(event) => {
          if (lastPointRef.current?.pointerId !== event.pointerId) return

          event.preventDefault()
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          lastPointRef.current = null
        }}
        onPointerCancel={(event) => {
          if (lastPointRef.current?.pointerId !== event.pointerId) return

          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          lastPointRef.current = null
        }}
        onLostPointerCapture={(event) => {
          if (lastPointRef.current?.pointerId === event.pointerId) {
            lastPointRef.current = null
          }
        }}
      />

      {!splitResults && activeViewerMode === 'results' ? resultsPanel : null}

      {activeViewerMode !== 'results' && parts.length === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">
          {emptyMessage}
        </div>
      ) : null}

      {activeViewerMode === 'material-grid' && gridStatus === 'ready' && !hasColoredGeometry ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">
          No colored Material geometry is available for Grid points.
        </div>
      ) : null}

      {activeViewerMode === 'material-grid' &&
      gridStatus === 'ready' &&
      hasColoredGeometry &&
      currentGridResult?.visiblePointCount === 0 ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">
          No Grid points fall inside the geometry at this spacing.
        </div>
      ) : null}

      {activeViewerMode !== 'results' && parts.length > 0 ? (
        <div className="pointer-events-none absolute top-3 right-3 min-w-32 rounded border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm">
          <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">Materials</div>
          {[...new Set(parts.map((part) => part.material))].map((material, index) => {
            const color = materialColor(material)
            return (
              <div
                key={`${material?.name ?? 'unassigned'}-${index}`}
                className="flex items-center gap-2 py-0.5 text-xs text-slate-700"
              >
                {color ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm border border-black/10"
                    data-material-swatch="fill"
                    style={{ backgroundColor: color }}
                  />
                ) : (
                  <span className="grid h-2.5 w-2.5 shrink-0 items-center" data-material-swatch="wireframe">
                    <span className="block border-t-2" style={{ borderColor: unassignedGeometryColor }} />
                  </span>
                )}
                <span>{material?.name ?? 'Unassigned'}</span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )

  return (
    <div
      className="flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-slate-50 lg:min-h-0"
      data-results-layout={splitResults ? 'split' : 'tabs'}
      ref={viewerRef}
    >
      <ViewerToolbar
        availableSources={availableSources}
        gridError={gridError}
        gridResult={currentGridResult}
        gridStatus={gridStatus}
        hasResults={hasResults && !splitResults}
        lengthUnit={lengthUnit}
        mode={activeViewerMode}
        spacingDraft={spacingDraft}
        spacingError={spacingError}
        simulation={simulation}
        onApplySpacing={applySpacing}
        onChangeSpacing={setSpacingDraft}
        onSetCameraView={setCameraView}
        onSelectMode={setViewerMode}
        onToggleSource={onToggleSource}
        visibleSources={visibleSources}
      />

      <div
        className={
          splitResults
            ? 'grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(320px,var(--viewer-geometry-width))_5px_minmax(320px,1fr)] overflow-hidden'
            : 'grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden'
        }
        ref={resultsSplitRef}
        style={splitResults ? ({ '--viewer-geometry-width': `${geometryPanelWidth}px` } as CSSProperties) : undefined}
      >
        {viewerPanel}
        {splitResults ? (
          <div
            aria-label="3D Viewer와 Results 크기 조절"
            aria-orientation="vertical"
            aria-valuemax={Math.round(maximumSplitPercent)}
            aria-valuemin={Math.round(minimumSplitPercent)}
            aria-valuenow={Math.round(resultsSplitPercent)}
            className="group flex cursor-col-resize touch-none items-stretch justify-center bg-slate-200 outline-none hover:bg-slate-300 focus-visible:ring-2 focus-visible:ring-slate-500 focus-visible:ring-inset"
            role="separator"
            tabIndex={0}
            onDoubleClick={() => setResultsSplitPercent(defaultResultsSplitPercent)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              setResultsSplitPercent((current) =>
                clampResultsSplitPercent(current + (event.key === 'ArrowLeft' ? -2 : 2), viewerWidth),
              )
            }}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const bounds = resultsSplitRef.current?.getBoundingClientRect()
              if (!bounds) return
              const percent =
                ((event.clientX - bounds.left) / Math.max(1, bounds.width - resultsSplitDividerWidth)) * 100
              setResultsSplitPercent(clampResultsSplitPercent(percent, bounds.width))
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
          >
            <span className="w-px bg-slate-300 group-hover:bg-slate-400" />
          </div>
        ) : null}
        {splitResults ? (
          <div className="min-h-0 min-w-0 overflow-hidden border-l border-slate-200">{resultsPanel}</div>
        ) : null}
      </div>
    </div>
  )
}

export default JscadViewer
