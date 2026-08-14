import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as reglRenderer from '@jscad/regl-renderer'
import type { CadScenePart, UcumUnit } from '@/lib/cad'
import { scenePartColor, unassignedGeometryColor } from './materialColor'
import { createWireframeGeometries } from './renderParts'
import { createLayerRenderParts, scaleViewerLayers, type CadViewerSource, type JscadViewerLayer } from './sourceLayers'

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

type CameraView = 'default' | 'x' | 'y' | 'z'

type JscadViewerProps = {
  availableSources?: readonly CadViewerSource[]
  emptyMessage?: string
  layers: readonly JscadViewerLayer[]
  lengthUnit: UcumUnit
  onRenderEnd: () => void
  onRenderError: (message: string) => void
  onRenderStart: () => void
  onToggleSource?: (source: CadViewerSource) => void
  visibleSources?: readonly CadViewerSource[]
}

const renderer = reglRenderer as unknown as ReglRendererApi
const cameraViewDirections = {
  default: [1, 1, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const

export function ViewerToolbar({
  availableSources = [],
  onSetCameraView,
  onToggleSource,
  visibleSources = [],
}: {
  availableSources?: readonly CadViewerSource[]
  onSetCameraView: (view: CameraView) => void
  onToggleSource?: (source: CadViewerSource) => void
  visibleSources?: readonly CadViewerSource[]
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
  visibleSources,
}: JscadViewerProps) {
  const displayLayers = useMemo(() => scaleViewerLayers(layers, lengthUnit), [layers, lengthUnit])
  const parts = useMemo(() => displayLayers.flatMap((layer) => layer.parts), [displayLayers])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<RendererState | null>(null)
  const controlsRef = useRef<RendererState | null>(null)
  const lastFittedPartsRef = useRef<readonly CadScenePart[] | null>(null)
  const lastPointRef = useRef<{
    button: 0 | 2
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const optionsRef = useRef<RendererOptions | null>(null)
  const rendererEntityCacheRef = useRef(new Map<string, RendererEntity[]>())
  const referenceEntitiesRef = useRef<RendererEntity[]>([])
  const renderRef = useRef<((options: RendererOptions) => void) | null>(null)
  const renderErrorRef = useRef(onRenderError)
  renderErrorRef.current = onRenderError

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
      optionsRef.current.entities = referenceEntitiesRef.current
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
          })
        : null
      let geometryEntities = cacheKey ? rendererEntityCacheRef.current.get(cacheKey) : undefined
      if (!geometryEntities) {
        const renderParts = createLayerRenderParts(displayLayers)
        const wireframeEntities = renderParts
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
          rendererEntityCacheRef.current.set(cacheKey, geometryEntities)
          if (rendererEntityCacheRef.current.size > 16) {
            rendererEntityCacheRef.current.delete(rendererEntityCacheRef.current.keys().next().value!)
          }
        }
      }

      optionsRef.current.entities = [...referenceEntitiesRef.current, ...geometryEntities]
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
      if (!renderScene()) return
      if (shouldFit) {
        lastFittedPartsRef.current = parts
        onRenderEnd()
      }
    } catch (error) {
      const typedError = error as { message?: string }
      onRenderError(typedError.message ?? String(error))
    }
  }, [displayLayers, lengthUnit, onRenderEnd, onRenderError, onRenderStart, parts, renderScene])

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

  return (
    <div className="flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-slate-50 lg:min-h-0">
      <ViewerToolbar
        availableSources={availableSources}
        visibleSources={visibleSources}
        onSetCameraView={setCameraView}
        onToggleSource={onToggleSource}
      />

      <div aria-label="Geometry Viewer" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          className="block h-full w-full cursor-grab touch-none active:cursor-grabbing"
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
            if (lastPointRef.current?.pointerId === event.pointerId) lastPointRef.current = null
          }}
        />

        {parts.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500">
            {emptyMessage}
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
