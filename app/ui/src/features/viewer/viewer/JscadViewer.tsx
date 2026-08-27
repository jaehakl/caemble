import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as reglRenderer from '@jscad/regl-renderer'
import { Copy, Focus, Maximize2, Minimize2, SearchCode, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CadScenePart, RayPathBundle, UcumUnit } from '@/lib/cad'
import { scenePartColor, unassignedGeometryColor } from './materialColor'
import { createWireframeGeometries, geometryWithSelectedPolygons, viewerSelectionColor } from './renderParts'
import { createRayPathRenderGeometries } from './rayPathRendering'
import { createLayerRenderParts, scaleViewerLayers, type CadViewerSource, type JscadViewerLayer } from './sourceLayers'
import {
  createCadViewerPickParts,
  pickCadViewerTargets,
  resolveCadViewerSelection,
  type CadViewerPickMode,
  type CadViewerPickingCamera,
  type CadViewerSelectionQuery,
  type CadViewerSourceLookupStatus,
} from './selection'

type RendererEntity = Record<string, unknown>
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
type ReglCommandBuilder = {
  (options: Record<string, unknown>): (props: Record<string, unknown>) => void
  prop: (name: string) => unknown
}

type CameraView = 'default' | 'x' | 'y' | 'z'

type JscadViewerProps = {
  availableSources?: readonly CadViewerSource[]
  emptyMessage?: string
  layers: readonly JscadViewerLayer[]
  lengthUnit: UcumUnit
  onRenderEnd: () => void
  onRenderError: (message: string) => void
  onRenderStart: () => void
  onFindSelectionSource?: (value: string) => void
  onSelectionQueryChange?: (query: CadViewerSelectionQuery | null) => void
  onSelectionSourcePathsChange?: (values: readonly string[]) => void
  onToggleSource?: (source: CadViewerSource) => void
  onToggleViewerExpanded?: () => void
  selectionQuery?: CadViewerSelectionQuery | null
  rayPaths?: readonly RayPathBundle[]
  viewerExpanded?: boolean
  selectionSourceStatus?: Readonly<Record<string, CadViewerSourceLookupStatus>>
  visibleSources?: readonly CadViewerSource[]
}

const renderer = reglRenderer as unknown as ReglRendererApi
const rayPathVertexShader = `
precision mediump float;
uniform mat4 view, projection;
attribute vec3 position;
attribute vec4 color;
varying vec4 vertexColor;
void main() {
  vertexColor = color;
  gl_Position = projection * view * vec4(position, 1.0);
}
`
const rayPathFragmentShader = `
precision mediump float;
varying vec4 vertexColor;
void main() { gl_FragColor = vertexColor; }
`
function drawRayPaths(regl: ReglCommandBuilder) {
  return regl({
    primitive: 'lines',
    vert: rayPathVertexShader,
    frag: rayPathFragmentShader,
    attributes: {
      position: regl.prop('positions'),
      color: regl.prop('colors'),
    },
    elements: regl.prop('indices'),
    depth: { enable: false },
    blend: {
      enable: true,
      func: { src: 'src alpha', dst: 'one minus src alpha' },
    },
  })
}
const cameraViewDirections = {
  default: [1, 1, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const

export function ViewerToolbar({
  availableSources = [],
  onPickModeChange,
  onSetCameraView,
  onToggleSource,
  onToggleViewerExpanded,
  onToggleXray,
  pickMode,
  viewerExpanded = false,
  visibleSources = [],
  xrayEnabled,
}: {
  availableSources?: readonly CadViewerSource[]
  onPickModeChange: (mode: CadViewerPickMode) => void
  onSetCameraView: (view: CameraView) => void
  onToggleSource?: (source: CadViewerSource) => void
  onToggleViewerExpanded?: () => void
  onToggleXray: () => void
  pickMode: CadViewerPickMode
  viewerExpanded?: boolean
  visibleSources?: readonly CadViewerSource[]
  xrayEnabled: boolean
}) {
  return (
    <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-2 py-1">
      <div aria-label="Camera views" className="flex items-center gap-1">
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

      <button
        aria-label="Toggle X-ray"
        aria-pressed={xrayEnabled}
        className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
          xrayEnabled
            ? 'border-sky-400 bg-sky-50 text-sky-900'
            : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800'
        }`}
        title="내부 Geometry를 보기 위한 반투명 표시"
        type="button"
        onClick={onToggleXray}
      >
        X-ray
      </button>

      <div aria-label="Viewer selection mode" className="flex items-center gap-1 border-l border-slate-200 pl-3">
        {(['off', 'geometry', 'surface'] as const).map((mode) => (
          <button
            aria-label={`Selection mode ${mode}`}
            aria-pressed={pickMode === mode}
            className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
              pickMode === mode
                ? 'border-orange-400 bg-orange-50 text-orange-900'
                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300 hover:text-slate-800'
            }`}
            key={mode}
            type="button"
            onClick={() => onPickModeChange(mode)}
          >
            {mode === 'off' ? 'Off' : mode === 'geometry' ? 'Geometry' : 'Surface'}
          </button>
        ))}
      </div>

      {onToggleSource ? (
        <div aria-label="Viewer sources" className="flex items-center gap-1 border-l border-slate-200 pl-3">
          {(['experiment', 'task'] as const).map((source) => {
            const available = availableSources.includes(source)
            const visible = visibleSources.includes(source)
            return (
              <button
                aria-label={`Toggle ${source}`}
                aria-pressed={available && visible}
                className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                  available && visible
                    ? 'border-slate-400 bg-slate-100 text-slate-900'
                    : 'border-slate-200 bg-white text-slate-400'
                } disabled:cursor-not-allowed disabled:opacity-50`}
                disabled={!available}
                key={source}
                type="button"
                onClick={() => onToggleSource(source)}
              >
                {source === 'experiment' ? 'Experiment' : 'Task'}
              </button>
            )
          })}
        </div>
      ) : null}

      {onToggleViewerExpanded ? (
        <button
          aria-label={viewerExpanded ? 'Viewer 영역 복원' : 'Viewer 확장'}
          aria-pressed={viewerExpanded}
          className="ml-auto flex size-7 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:text-slate-950"
          title={viewerExpanded ? '좌측 및 하단 영역 복원' : '좌측 및 하단 영역 숨기기'}
          type="button"
          onClick={onToggleViewerExpanded}
        >
          {viewerExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
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
  onFindSelectionSource,
  onSelectionQueryChange,
  onSelectionSourcePathsChange,
  onToggleSource,
  onToggleViewerExpanded,
  rayPaths = [],
  selectionQuery = null,
  selectionSourceStatus = {},
  viewerExpanded,
  visibleSources,
}: JscadViewerProps) {
  const [pickMode, setPickMode] = useState<CadViewerPickMode>('off')
  const [xrayEnabled, setXrayEnabled] = useState(false)
  const displayLayers = useMemo(() => scaleViewerLayers(layers, lengthUnit), [layers, lengthUnit])
  const parts = useMemo(() => displayLayers.flatMap((layer) => layer.parts), [displayLayers])
  const selectionMatches = useMemo(
    () => resolveCadViewerSelection(displayLayers, selectionQuery),
    [displayLayers, selectionQuery],
  )
  const selectionSourcePaths = useMemo(
    () =>
      selectionQuery
        ? [
            ...new Set(
              selectionMatches.length > 0
                ? selectionMatches.map((match) => match.surfaceId ?? match.geometryId)
                : [selectionQuery.value],
            ),
          ]
        : [],
    [selectionMatches, selectionQuery],
  )
  const pickParts = useMemo(
    () => (pickMode === 'off' ? [] : createCadViewerPickParts(displayLayers)),
    [displayLayers, pickMode],
  )
  const rayPathGeometries = useMemo(() => createRayPathRenderGeometries(rayPaths, lengthUnit), [lengthUnit, rayPaths])
  const rayPathVisualsRef = useRef<Record<string, unknown>>({
    drawCmd: 'drawRayPaths',
    show: true,
    transparent: true,
  })
  const rayPathEntities = useMemo(
    () =>
      rayPathGeometries.map((geometry) => ({
        colors: geometry.colors,
        indices: geometry.indices,
        positions: geometry.positions,
        visuals: rayPathVisualsRef.current,
      })),
    [rayPathGeometries],
  )
  const rayPathCount = rayPaths.reduce((sum, bundle) => sum + bundle.pathCount, 0)
  const raySegmentCount = rayPaths.reduce((sum, bundle) => sum + bundle.segmentCount, 0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<RendererState | null>(null)
  const controlsRef = useRef<RendererState | null>(null)
  const lastFittedPartsRef = useRef<readonly CadScenePart[] | null>(null)
  const lastPointRef = useRef<{
    button: 0 | 2
    moved: boolean
    pointerId: number
    startX: number
    startY: number
    x: number
    y: number
  } | null>(null)
  const optionsRef = useRef<RendererOptions | null>(null)
  const rendererEntityCacheRef = useRef(new Map<string, RendererEntity[]>())
  const referenceEntitiesRef = useRef<RendererEntity[]>([])
  const renderRef = useRef<((options: RendererOptions) => void) | null>(null)
  const renderErrorRef = useRef(onRenderError)
  renderErrorRef.current = onRenderError

  useEffect(() => {
    if (selectionQuery?.origin === 'viewer' && selectionMatches.length === 0) onSelectionQueryChange?.(null)
  }, [onSelectionQueryChange, selectionMatches.length, selectionQuery])

  useEffect(() => {
    onSelectionSourcePathsChange?.(selectionSourcePaths)
  }, [onSelectionSourcePathsChange, selectionSourcePaths])

  const renderScene = useCallback(() => {
    if (!renderRef.current || !optionsRef.current) return false
    try {
      renderRef.current(optionsRef.current)
      return true
    } catch (error) {
      const typedError = error as { message?: string }
      renderErrorRef.current(typedError.message ?? String(error))
      return false
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    delete rayPathVisualsRef.current.cacheId

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
    lastFittedPartsRef.current = null
    rendererEntityCacheRef.current.clear()
    referenceEntitiesRef.current = [
      {
        size: [120, 120],
        ticks: [10, 2],
        visuals: { drawCmd: 'drawGrid', show: true },
      },
      {
        size: 70,
        visuals: { drawCmd: 'drawAxis', show: true },
      },
    ]

    const options = {
      camera,
      drawCommands: {
        drawAxis: renderer.drawCommands.drawAxis,
        drawGrid: renderer.drawCommands.drawGrid,
        drawLines: renderer.drawCommands.drawLines,
        drawMesh: renderer.drawCommands.drawMesh,
        drawRayPaths,
      },
      entities: [],
      glOptions: { canvas },
      rendering: { background: [0.98, 0.99, 1, 1] },
    }

    optionsRef.current = options
    try {
      renderRef.current = renderer.prepareRender(options)
    } catch (error) {
      const typedError = error as { message?: string }
      renderErrorRef.current(typedError.message ?? String(error))
      optionsRef.current = null
      return
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
      const rect = canvas.parentElement?.getBoundingClientRect()
      const width = Math.max(1, Math.floor(rect?.width ?? canvas.clientWidth))
      const height = Math.max(1, Math.floor(rect?.height ?? canvas.clientHeight))
      const ratio = window.devicePixelRatio || 1

      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      perspectiveCamera.setProjection(camera, camera, { width: canvas.width, height: canvas.height })
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
  }, [renderScene])

  useEffect(() => {
    if (!optionsRef.current || !renderRef.current || !cameraRef.current || !controlsRef.current) return

    if (parts.length === 0) {
      optionsRef.current.entities = [...referenceEntitiesRef.current, ...rayPathEntities]
      renderScene()
      lastFittedPartsRef.current = null
      return
    }

    const shouldFit = lastFittedPartsRef.current !== parts
    if (shouldFit) onRenderStart()

    try {
      const cacheKey = displayLayers.every((layer) => layer.sceneHash)
        ? JSON.stringify({
            lengthUnit,
            scenes: displayLayers.map((layer) => [
              layer.source,
              layer.taskName ?? null,
              layer.sceneHash,
              layer.parts.map((part) => [part.id, part.materialRole, scenePartColor(part)]),
            ]),
            selection: selectionMatches.map((match) => [
              match.source,
              match.taskName ?? null,
              match.geometryId,
              match.surfaceId ?? null,
            ]),
            xray: xrayEnabled,
          })
        : null
      let geometryEntities = cacheKey ? rendererEntityCacheRef.current.get(cacheKey) : undefined
      if (!geometryEntities) {
        const renderParts = createLayerRenderParts(displayLayers, selectionMatches, xrayEnabled)
        const wireframeEntities = renderParts.flatMap((part) =>
          createWireframeGeometries(part, xrayEnabled).map((geometry) => ({
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
          .flatMap((part) =>
            renderer.entitiesFromSolids({ color: part.color, smoothNormals: true }, part.geometry).map((entity) =>
              part.color[3] < 1
                ? {
                    ...entity,
                    extras: { depth: { enable: true, mask: false } },
                  }
                : entity,
            ),
          )
        const selectionEntities = renderParts.flatMap((part) =>
          part.selectionGeometry
            ? renderer
                .entitiesFromSolids({ color: viewerSelectionColor, smoothNormals: false }, part.selectionGeometry)
                .map((entity) => ({
                  ...entity,
                  extras: {
                    cull: { enable: false },
                    depth: { enable: true, func: 'lequal' },
                  },
                }))
            : [],
        )
        geometryEntities = xrayEnabled
          ? [...wireframeEntities, ...meshEntities, ...selectionEntities]
          : [...meshEntities, ...wireframeEntities, ...selectionEntities]
        if (cacheKey) {
          rendererEntityCacheRef.current.set(cacheKey, geometryEntities)
          if (rendererEntityCacheRef.current.size > 16) {
            rendererEntityCacheRef.current.delete(rendererEntityCacheRef.current.keys().next().value!)
          }
        }
      }

      optionsRef.current.entities = [...referenceEntitiesRef.current, ...geometryEntities, ...rayPathEntities]
      if (shouldFit) {
        const meshFitEntities = geometryEntities.filter((entity) => {
          const visuals = entity.visuals
          return (
            typeof visuals === 'object' && visuals !== null && 'drawCmd' in visuals && visuals.drawCmd === 'drawMesh'
          )
        })
        const zoomed = renderer.controls.orbit.zoomToFit({
          camera: cameraRef.current,
          controls: controlsRef.current,
          entities: meshFitEntities.length > 0 ? meshFitEntities : geometryEntities,
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
      if (!renderScene()) return
      if (shouldFit) {
        lastFittedPartsRef.current = parts
        onRenderEnd()
      }
    } catch (error) {
      const typedError = error as { message?: string }
      onRenderError(typedError.message ?? String(error))
    }
  }, [
    displayLayers,
    lengthUnit,
    onRenderEnd,
    onRenderError,
    onRenderStart,
    parts,
    rayPathEntities,
    renderScene,
    selectionMatches,
    xrayEnabled,
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
    renderScene()
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
    Object.assign(controlsRef.current, { phiDelta: 0, scale: 1, thetaDelta: 0 })
    renderWithControls()
  }

  const focusSelectionMatch = (match: (typeof selectionMatches)[number]) => {
    if (!cameraRef.current || !controlsRef.current) return
    const layer = displayLayers.find(
      (candidate) =>
        candidate.source === match.source &&
        (candidate.source === 'experiment' || candidate.taskName === match.taskName),
    )
    const part = layer?.parts.find((candidate) => candidate.id === match.geometryId)
    if (!part) return
    let geometry = part.geometry
    if (match.surfaceId) {
      const surface = part.surfaces.find((candidate) => candidate.id === match.surfaceId)
      if (!surface || surface.polygonIndices.length === 0) return
      geometry = geometryWithSelectedPolygons(part.geometry, new Set(surface.polygonIndices), true)
    }
    const entities = renderer.entitiesFromSolids({ color: viewerSelectionColor, smoothNormals: false }, geometry)
    if (entities.length === 0) return
    const zoomed = renderer.controls.orbit.zoomToFit({
      camera: cameraRef.current,
      controls: controlsRef.current,
      entities,
    })
    Object.assign(cameraRef.current, zoomed.camera)
    Object.assign(controlsRef.current, zoomed.controls)
    renderWithControls()
  }

  return (
    <div className="flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-slate-50 lg:min-h-0">
      <ViewerToolbar
        availableSources={availableSources}
        pickMode={pickMode}
        visibleSources={visibleSources}
        onPickModeChange={setPickMode}
        onSetCameraView={setCameraView}
        onToggleSource={onToggleSource}
        onToggleViewerExpanded={onToggleViewerExpanded}
        onToggleXray={() => setXrayEnabled((current) => !current)}
        viewerExpanded={viewerExpanded}
        xrayEnabled={xrayEnabled}
      />

      <div aria-label="Geometry Viewer" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className={`block h-full w-full touch-none ${
            pickMode === 'off' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'
          }`}
          data-viewer-canvas="true"
          onContextMenu={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.button !== 0 && event.button !== 2) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            lastPointRef.current = {
              button: event.button,
              moved: false,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
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
            lastPointRef.current = {
              ...lastPoint,
              moved:
                lastPoint.moved || Math.hypot(event.clientX - lastPoint.startX, event.clientY - lastPoint.startY) > 4,
              x: event.clientX,
              y: event.clientY,
            }
            renderWithControls()
          }}
          onPointerUp={(event) => {
            const lastPoint = lastPointRef.current
            if (lastPoint?.pointerId !== event.pointerId) return
            event.preventDefault()
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            lastPointRef.current = null
            if (lastPoint.button !== 0 || lastPoint.moved || pickMode === 'off' || !cameraRef.current) return
            const rect = event.currentTarget.getBoundingClientRect()
            const point = {
              height: rect.height,
              width: rect.width,
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            }
            const hits = pickCadViewerTargets(pickParts, cameraRef.current as CadViewerPickingCamera, point, pickMode)
            if (hits.length === 0) {
              onSelectionQueryChange?.(null)
              return
            }
            const hit = xrayEnabled ? hits[hits.length - 1] : hits[0]
            onSelectionQueryChange?.({
              kind: pickMode,
              match: 'exact',
              origin: 'viewer',
              scope:
                hit.source === 'experiment' ? { source: 'experiment' } : { source: 'task', taskName: hit.taskName! },
              value: pickMode === 'surface' ? hit.surfaceId! : hit.geometryId,
            })
          }}
          onPointerCancel={(event) => {
            if (lastPointRef.current?.pointerId !== event.pointerId) return
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            lastPointRef.current = null
          }}
          onLostPointerCapture={(event) => {
            if (lastPointRef.current?.pointerId === event.pointerId) lastPointRef.current = null
          }}
        />

        {selectionQuery ? (
          <div className="absolute top-2 left-2 z-10 max-h-[33%] w-fit max-w-[min(20rem,calc(100%-1rem))] overflow-auto rounded border border-white/60 bg-white/65 p-1 text-[9px] text-slate-800 shadow-sm backdrop-blur-sm">
            <div className="flex min-w-0 items-start gap-0.5">
              <div className="min-w-0 flex-1 space-y-0.5">
                {selectionMatches.length === 0 ? (
                  <div className="flex min-w-0 items-center gap-1 px-0.5 py-0.5">
                    <span className="max-w-56 min-w-0 truncate font-mono" title={selectionQuery.value}>
                      {selectionQuery.value}
                    </span>
                    <span className="shrink-0 text-amber-700">찾지 못함</span>
                    {onFindSelectionSource ? (
                      <button
                        aria-label={`Find ${selectionQuery.value} in Source`}
                        className="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/70 hover:text-slate-900 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                        disabled={selectionSourceStatus[selectionQuery.value] !== 'available'}
                        title={
                          selectionSourceStatus[selectionQuery.value] === 'available'
                            ? 'Source에서 전역 경로 찾기'
                            : selectionSourceStatus[selectionQuery.value] === 'missing'
                              ? 'Source에서 일치하는 경로 없음'
                              : 'Source 위치 확인 중'
                        }
                        type="button"
                        onClick={() => onFindSelectionSource(selectionQuery.value)}
                      >
                        <SearchCode className="size-3" />
                      </button>
                    ) : null}
                  </div>
                ) : (
                  selectionMatches.map((match) => {
                    const path = match.surfaceId ?? match.geometryId
                    const layerLabel = match.source === 'experiment' ? 'Exp' : `T·${match.taskName}`
                    return (
                      <div
                        className="flex min-w-0 items-center gap-0.5"
                        key={`${match.source}:${match.taskName ?? ''}:${match.geometryId}:${match.surfaceId ?? ''}`}
                      >
                        {selectionMatches.length > 1 ? (
                          <span
                            className="max-w-16 shrink-0 truncate rounded bg-slate-900/5 px-1 py-0.5 text-[8px] text-slate-500"
                            title={match.source === 'experiment' ? 'Experiment' : `Task · ${match.taskName}`}
                          >
                            {layerLabel}
                          </span>
                        ) : null}
                        <span className="max-w-56 min-w-0 flex-1 truncate font-mono" title={path}>
                          {path}
                        </span>
                        {onFindSelectionSource ? (
                          <button
                            aria-label={`Find ${path} in Source`}
                            className="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/70 hover:text-slate-900 disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                            disabled={selectionSourceStatus[path] !== 'available'}
                            title={
                              selectionSourceStatus[path] === 'available'
                                ? 'Source에서 전역 경로 찾기'
                                : selectionSourceStatus[path] === 'missing'
                                  ? 'Source에서 일치하는 경로 없음'
                                  : 'Source 위치 확인 중'
                            }
                            type="button"
                            onClick={() => onFindSelectionSource(path)}
                          >
                            <SearchCode className="size-3" />
                          </button>
                        ) : null}
                        <button
                          aria-label={`Focus Viewer on ${path}`}
                          className="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/70 hover:text-slate-900"
                          title="선택 요소에 카메라 맞추기"
                          type="button"
                          onClick={() => focusSelectionMatch(match)}
                        >
                          <Focus className="size-3" />
                        </button>
                        <button
                          aria-label={`Copy selected ID ${path}`}
                          className="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/70 hover:text-slate-900"
                          title="전역 경로 복사"
                          type="button"
                          onClick={() => {
                            void navigator.clipboard
                              .writeText(path)
                              .then(() => toast.success('전역 경로를 복사했습니다.'))
                              .catch(() => toast.error('전역 경로를 복사하지 못했습니다.'))
                          }}
                        >
                          <Copy className="size-3" />
                        </button>
                      </div>
                    )
                  })
                )}
              </div>
              <button
                aria-label="Clear Viewer selection"
                className="grid size-5 shrink-0 place-items-center rounded text-slate-500 hover:bg-white/70 hover:text-slate-900"
                title="선택 해제"
                type="button"
                onClick={() => onSelectionQueryChange?.(null)}
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        ) : null}

        {parts.length === 0 && rayPathCount === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">
            {emptyMessage}
          </div>
        ) : null}

        {rayPathCount > 0 ? (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-700 shadow-sm backdrop-blur-sm">
            Ray paths · {rayPathCount.toLocaleString()} paths · {raySegmentCount.toLocaleString()} segments
          </div>
        ) : null}

        {parts.length > 0 ? (
          <div className="pointer-events-none absolute top-3 right-3 min-w-32 rounded border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm">
            <div className="mb-1.5 text-[10px] font-semibold tracking-wide text-slate-500 uppercase">Materials</div>
            {[...new Map(parts.map((part) => [part.materialRole, part])).values()].map((part, index) => {
              const color = scenePartColor(part)
              const role = typeof part.materialRole === 'string' && part.materialRole.trim() ? part.materialRole : null
              return (
                <div
                  key={role ?? `unassigned-${index}`}
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
                  <span>
                    {role ? (part.material ? `${role}: ${part.material.name}` : `${role} (Unresolved)`) : 'Unassigned'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default JscadViewer
