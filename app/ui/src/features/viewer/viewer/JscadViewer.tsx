import { ViewerToolbar, type CameraView } from './ViewerToolbar'
import { viewerScaleBar } from './scaleBar'
import { useViewerComparison, useViewerSetting } from './comparisonSettings'
import type { HeatmapRaster, HeatmapRenderData } from './structuredField'
import { heatmapTiles } from './pointCloudData'
import { measurements } from '@jscad/modeling'
import { cameraClipping, fitCameraToBounds, panCamera } from './cameraClipping'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as reglRenderer from '@jscad/regl-renderer'
import { Copy, Focus, SearchCode, X } from 'lucide-react'
import { toast } from 'sonner'
import type { CadScenePart } from '@/lib/cad/evaluation/types'
import type { PolylineBundle, UcumUnit } from '@/lib/cad/model'
import { scenePartColor, unassignedGeometryColor } from './materialColor'
import { createWireframeGeometries, geometryWithSelectedPolygons, viewerSelectionColor } from './renderParts'
import { createRayPathRenderGeometries } from './rayPathRendering'
import type { MeshRenderData } from './meshFields'
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
  texture: (options: Record<string, unknown>) => { destroy: () => void }
  limits: { maxTextureSize: number }
}

type JscadViewerProps = {
  availableSources?: readonly CadViewerSource[]
  emptyMessage?: string
  layers: readonly JscadViewerLayer[]
  lengthUnit: UcumUnit
  showScaleBar?: boolean
  onRenderEnd: () => void
  onRenderError: (message: string) => void
  onRenderStart: () => void
  onFindSelectionSource?: (value: string) => void
  onSelectionQueryChange?: (query: CadViewerSelectionQuery | null) => void
  onSelectionSourcePathsChange?: (values: readonly string[]) => void
  onToggleSource?: (source: CadViewerSource) => void
  onToggleViewerExpanded?: () => void
  selectionQuery?: CadViewerSelectionQuery | null
  polylines?: readonly PolylineBundle[]
  meshRenderData?: MeshRenderData
  preserveCameraOnUpdate?: boolean
  meshIdentity?: string
  heatmapRenderData?: HeatmapRenderData
  geometryOpacity?: number
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
function drawRecordedMesh(regl: ReglCommandBuilder, transparent = false) {
  return regl({
    primitive: regl.prop('primitive'),
    vert: `
      precision mediump float;
      uniform mat4 view, projection;
      uniform float depthBias;
      uniform float pointPixelRatio;
      attribute float pointSize;
      attribute vec3 position;
      attribute vec4 color;
      varying vec4 vertexColor;
      void main() {
        vertexColor = color;
        gl_Position = projection * view * vec4(position, 1.0);
        gl_Position.z -= depthBias * gl_Position.w;
        gl_PointSize = pointSize * pointPixelRatio;
      }
    `,
    frag: rayPathFragmentShader,
    attributes: {
      position: regl.prop('positions'),
      color: regl.prop('colors'),
      pointSize: (_context: unknown, props: { pointSizes?: Float32Array }) => props.pointSizes ?? { constant: 5 },
    },
    uniforms: {
      pointPixelRatio: () => window.devicePixelRatio || 1,
      depthBias: (_context: unknown, props: { primitive: string }) => (props.primitive === 'lines' ? 2e-5 : 1e-5),
    },
    elements: regl.prop('indices'),
    depth: { enable: true, func: 'lequal', mask: !transparent },
    blend: {
      enable: transparent,
      func: { srcRGB: 'src alpha', dstRGB: 'one minus src alpha', srcAlpha: 'one', dstAlpha: 'one minus src alpha' },
    },
    cull: { enable: false },
  })
}

function drawHeatmapRaster(regl: ReglCommandBuilder) {
  const draw = regl({
    primitive: 'triangles',
    vert: `
      precision highp float;
      uniform mat4 view, projection;
      attribute vec3 position;
      attribute vec2 uv;
      varying vec2 texCoord;
      void main() {
        texCoord = uv;
        gl_Position = projection * view * vec4(position, 1.0);
        gl_Position.z -= 1e-5 * gl_Position.w;
      }
    `,
    frag: `
      precision highp float;
      uniform sampler2D pixels;
      varying vec2 texCoord;
      void main() { gl_FragColor = texture2D(pixels, texCoord); }
    `,
    attributes: {
      position: regl.prop('positions'),
      uv: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    },
    uniforms: { pixels: regl.prop('texture') },
    elements: [
      [0, 1, 2],
      [0, 2, 3],
    ],
    depth: { enable: true, func: 'lequal', mask: true },
    blend: { enable: false },
    cull: { enable: false },
  })
  let current: HeatmapRaster | undefined
  const tiles: { positions: number[][]; texture: { destroy: () => void } }[] = []
  const clear = () => {
    for (const tile of tiles) tile.texture.destroy()
    tiles.length = 0
    current = undefined
  }
  return {
    clear,
    draw: (props: Record<string, unknown>) => {
      const raster = props.raster as HeatmapRaster
      if (current !== raster) {
        clear()
        try {
          for (const tile of heatmapTiles(raster, Math.min(2048, regl.limits.maxTextureSize))) {
            const positions = [
              [tile.x, tile.y],
              [tile.x + tile.width, tile.y],
              [tile.x + tile.width, tile.y + tile.height],
              [tile.x, tile.y + tile.height],
            ].map(([column, row]) =>
              raster.origin.map(
                (value, axis) =>
                  value +
                  (raster.columnVector[axis] * column) / raster.width +
                  (raster.rowVector[axis] * row) / raster.height,
              ),
            )
            tiles.push({
              positions,
              texture: regl.texture({
                width: tile.width,
                height: tile.height,
                data: tile.data,
                format: 'rgba',
                type: 'uint8',
                min: 'nearest',
                mag: 'nearest',
                wrap: 'clamp',
                flipY: false,
              }),
            })
          }
          current = raster
        } catch (error) {
          clear()
          throw error
        }
      }
      for (const tile of tiles) draw(tile)
    },
  }
}
const cameraViewDirections = {
  default: [1, 1, 1],
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const

function JscadViewer({
  availableSources,
  emptyMessage = 'Waiting for model...',
  layers,
  lengthUnit,
  showScaleBar = true,
  onRenderEnd,
  onRenderError,
  onRenderStart,
  onFindSelectionSource,
  onSelectionQueryChange,
  onSelectionSourcePathsChange,
  onToggleSource,
  onToggleViewerExpanded,
  polylines = [],
  meshRenderData,
  meshIdentity,
  preserveCameraOnUpdate = false,
  heatmapRenderData,
  geometryOpacity = 1,
  selectionQuery = null,
  selectionSourceStatus = {},
  viewerExpanded,
  visibleSources,
}: JscadViewerProps) {
  const savedCamera = useViewerComparison()?.camera
  const cameraToken = useRef({})
  const [pickMode, setPickMode] = useViewerSetting<CadViewerPickMode>('pickMode', 'off', 'workspace')
  const [xrayEnabled, setXrayEnabled] = useViewerSetting('xrayEnabled', false, 'workspace')
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
  const rayPathGeometries = useMemo(() => createRayPathRenderGeometries(polylines, lengthUnit), [lengthUnit, polylines])
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
  const rayPathCount = polylines.reduce((sum, bundle) => sum + bundle.pathCount, 0)
  const meshVisualsRef = useRef<Record<string, unknown>>({
    drawCmd: 'drawRecordedMesh',
    show: true,
    transparent: false,
  })
  const meshEntities = useMemo(
    () => meshRenderData?.geometries.map((geometry) => ({ ...geometry, visuals: meshVisualsRef.current })) ?? [],
    [meshRenderData],
  )
  const heatmapVisualsRef = useRef<Record<string, unknown>>({
    drawCmd: 'drawHeatmap',
    show: true,
    transparent: false,
  })
  const rasterVisualsRef = useRef<Record<string, unknown>>({
    drawCmd: 'drawHeatmapRaster',
    show: true,
    transparent: false,
  })
  const clearRasterRef = useRef<(() => void) | undefined>(undefined)
  const heatmapEntities = useMemo(
    () => [
      ...(heatmapRenderData?.geometries.map((geometry) => ({
        ...geometry,
        visuals: heatmapVisualsRef.current,
      })) ?? []),
      ...(heatmapRenderData?.raster ? [{ raster: heatmapRenderData.raster, visuals: rasterVisualsRef.current }] : []),
    ],
    [heatmapRenderData],
  )
  const resultIdentity = JSON.stringify([
    meshIdentity,
    heatmapRenderData?.identity,
    polylines.map((bundle) => bundle.id),
  ])
  const lastRenderedResultRef = useRef<string | null>(null)
  const cameraInitializedRef = useRef(false)
  const [viewportReady, setViewportReady] = useState(false)
  const geometryBounds = useMemo(() => {
    const boxes = displayLayers.flatMap((layer) =>
      layer.parts.map((part) =>
        measurements.measureBoundingBox(part.geometry as Parameters<typeof measurements.measureBoundingBox>[0]),
      ),
    )
    return boxes
  }, [displayLayers])
  const sceneBounds = useMemo(() => {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity]
    const boxes = [
      ...geometryBounds,
      ...(meshRenderData ? [[meshRenderData.bounds.min, meshRenderData.bounds.max]] : []),
      ...(heatmapRenderData ? [[heatmapRenderData.bounds.min, heatmapRenderData.bounds.max]] : []),
    ]
    for (const [lower, upper] of boxes)
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], lower[axis])
        max[axis] = Math.max(max[axis], upper[axis])
      }
    for (const geometry of rayPathGeometries)
      geometry.positions.forEach((value, index) => {
        min[index % 3] = Math.min(min[index % 3], value)
        max[index % 3] = Math.max(max[index % 3], value)
      })
    return min.every((value, axis) => Number.isFinite(value) && Number.isFinite(max[axis]) && value <= max[axis]) &&
      max.some((value, axis) => value > min[axis])
      ? ([min, max] as const)
      : null
  }, [geometryBounds, meshRenderData, heatmapRenderData, rayPathGeometries])
  const sceneBoundsRef = useRef(sceneBounds)
  sceneBoundsRef.current = sceneBounds
  const raySegmentCount = polylines.reduce((sum, bundle) => sum + bundle.segmentCount, 0)
  const scaleBarRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cameraRef = useRef<RendererState | null>(null)
  const controlsRef = useRef<RendererState | null>(null)
  const lastRenderedPartsRef = useRef<readonly CadScenePart[] | null>(null)
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

  const lengthUnitRef = useRef(lengthUnit)
  lengthUnitRef.current = lengthUnit
  const renderScene = useCallback(() => {
    if (!renderRef.current || !optionsRef.current) return false
    try {
      const camera = cameraRef.current
      const canvas = canvasRef.current
      if (camera && canvas) {
        Object.assign(
          camera,
          cameraClipping(sceneBoundsRef.current, camera.position as number[], camera.target as number[]),
        )
        renderer.cameras.perspective.setProjection(camera, camera, { width: canvas.width, height: canvas.height })
      }
      if (camera && canvas && scaleBarRef.current) {
        const position = camera.position as number[]
        const target = camera.target as number[]
        const scale = viewerScaleBar(
          Math.hypot(...position.map((value, i) => value - target[i])),
          Number(camera.fov),
          canvas.clientHeight,
        )
        scaleBarRef.current.style.width = `${scale?.width ?? 0}px`
        scaleBarRef.current.textContent = scale ? `${Number(scale.length.toPrecision(3))} ${lengthUnitRef.current}` : ''
      }
      renderRef.current(optionsRef.current)
      return true
    } catch (error) {
      const typedError = error as { message?: string }
      renderErrorRef.current(typedError.message ?? String(error))
      return false
    }
  }, [])

  const fitCamera = useCallback(() => {
    const camera = cameraRef.current
    const controls = controlsRef.current
    const sharedExtent = savedCamera?.fitExtent()
    const bounds = sharedExtent?.bounds ?? sceneBoundsRef.current
    const viewport = sharedExtent ?? canvasRef.current?.parentElement?.getBoundingClientRect()
    if (!camera || !controls || !bounds || !viewport) return false
    const fitted = fitCameraToBounds({
      bounds,
      position: camera.position as number[],
      target: camera.target as number[],
      up: camera.up as number[],
      fov: Number(camera.fov),
      width: viewport.width,
      height: viewport.height,
    })
    if (!fitted) return false
    Object.assign(camera, fitted)
    const diameter = Math.hypot(...bounds[1].map((value, axis) => value - bounds[0][axis]))
    Object.assign(controls, {
      phiDelta: 0,
      thetaDelta: 0,
      scale: 1,
      limits: { ...(controls.limits as object), minDistance: diameter * 1e-6, maxDistance: diameter * 1e6 },
    })
    cameraInitializedRef.current = true
    return true
  }, [savedCamera])

  const publishCamera = useCallback(() => {
    const camera = cameraRef.current
    if (!savedCamera || !camera || !cameraInitializedRef.current) return
    savedCamera.publish(cameraToken.current, {
      position: Array.from(camera.position as number[]),
      target: Array.from(camera.target as number[]),
      up: Array.from(camera.up as number[]),
      fov: Number(camera.fov),
    })
  }, [savedCamera])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const capture = () => {
      renderScene()
    }
    canvas.addEventListener('caemble-before-capture', capture)
    return () => canvas.removeEventListener('caemble-before-capture', capture)
  }, [renderScene])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    delete rayPathVisualsRef.current.cacheId
    delete meshVisualsRef.current.cacheId
    delete heatmapVisualsRef.current.cacheId
    delete rasterVisualsRef.current.cacheId

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
    if (savedCamera?.current) Object.assign(camera, structuredClone(savedCamera.current))

    cameraRef.current = camera
    controlsRef.current = controls
    lastRenderedPartsRef.current = null
    lastRenderedResultRef.current = null
    cameraInitializedRef.current = Boolean(savedCamera?.current)
    rendererEntityCacheRef.current.clear()
    referenceEntitiesRef.current = []

    let rasterCommand: ReturnType<typeof drawHeatmapRaster> | undefined
    const options = {
      camera,
      drawCommands: {
        drawAxis: renderer.drawCommands.drawAxis,
        drawGrid: renderer.drawCommands.drawGrid,
        drawLines: renderer.drawCommands.drawLines,
        drawMesh: renderer.drawCommands.drawMesh,
        drawRayPaths,
        drawRecordedMesh: (regl: ReglCommandBuilder) => drawRecordedMesh(regl, false),
        drawHeatmap: (regl: ReglCommandBuilder) => drawRecordedMesh(regl, false),
        drawHeatmapRaster: (regl: ReglCommandBuilder) => {
          rasterCommand ??= drawHeatmapRaster(regl)
          clearRasterRef.current = rasterCommand.clear
          return rasterCommand.draw
        },
      },
      entities: [],
      glOptions: { canvas, attributes: { preserveDrawingBuffer: true } },
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
      publishCamera()
      renderScene()
    }

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      const visibleWidth = rect?.width ?? canvas.clientWidth
      const visibleHeight = rect?.height ?? canvas.clientHeight
      setViewportReady(visibleWidth > 0 && visibleHeight > 0)
      const width = Math.max(1, Math.floor(visibleWidth))
      const height = Math.max(1, Math.floor(visibleHeight))
      const ratio = window.devicePixelRatio || 1

      canvas.width = Math.floor(width * ratio)
      canvas.height = Math.floor(height * ratio)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      perspectiveCamera.setProjection(camera, camera, { width: canvas.width, height: canvas.height })
      perspectiveCamera.update(camera, camera)
      publishCamera()
      renderScene()
    }

    const resizeObserver = new ResizeObserver(resize)
    canvas.addEventListener('wheel', wheelHandler, { passive: false })
    if (canvas.parentElement) resizeObserver.observe(canvas.parentElement)
    resize()

    return () => {
      canvas.removeEventListener('wheel', wheelHandler)
      resizeObserver.disconnect()
      rasterCommand?.clear()
      clearRasterRef.current = undefined
      renderRef.current = null
      optionsRef.current = null
    }
  }, [renderScene, savedCamera, publishCamera])

  // Release textures even when the next view has no raster and never invokes its draw command.
  useEffect(() => () => clearRasterRef.current?.(), [heatmapRenderData])

  useEffect(() => {
    if (!optionsRef.current || !renderRef.current || !cameraRef.current || !controlsRef.current) return

    const sceneChanged = lastRenderedPartsRef.current !== parts || lastRenderedResultRef.current !== resultIdentity
    const shouldFit =
      viewportReady &&
      Boolean(sceneBounds) &&
      (!cameraInitializedRef.current || (!preserveCameraOnUpdate && !savedCamera && sceneChanged))
    if (sceneBounds) {
      const diameter = Math.max(
        Math.hypot(...sceneBounds[1].map((value, axis) => value - sceneBounds[0][axis])),
        Number.EPSILON,
      )
      controlsRef.current.limits = {
        ...(controlsRef.current.limits as object),
        minDistance: diameter * 1e-6,
        maxDistance: diameter * 1e6,
      }
    }
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
            geometryOpacity,
          })
        : null
      let geometryEntities = cacheKey ? rendererEntityCacheRef.current.get(cacheKey) : undefined
      if (!geometryEntities) {
        const renderParts = createLayerRenderParts(displayLayers, selectionMatches, xrayEnabled, geometryOpacity)
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
                    depth: {
                      enable: true,
                      func: 'lequal',
                      mask: (entity.visuals as { transparent?: boolean }).transparent !== true,
                    },
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

      optionsRef.current.entities = [
        ...referenceEntitiesRef.current,
        ...geometryEntities,
        ...meshEntities,
        ...heatmapEntities,
        ...rayPathEntities,
      ]
      if (shouldFit) fitCamera()

      const updated = renderer.controls.orbit.update({
        camera: cameraRef.current,
        controls: controlsRef.current,
      })
      Object.assign(cameraRef.current, updated.camera)
      Object.assign(controlsRef.current, updated.controls)
      renderer.cameras.perspective.update(cameraRef.current, cameraRef.current)
      if (shouldFit) publishCamera()
      if (!renderScene()) return
      if (shouldFit || sceneChanged) {
        lastRenderedPartsRef.current = parts
        lastRenderedResultRef.current = resultIdentity
        onRenderEnd()
      }
    } catch (error) {
      const typedError = error as { message?: string }
      onRenderError(typedError.message ?? String(error))
    }
  }, [
    displayLayers,
    viewportReady,
    fitCamera,
    publishCamera,
    preserveCameraOnUpdate,
    savedCamera,
    sceneBounds,
    resultIdentity,
    lengthUnit,
    onRenderEnd,
    onRenderError,
    onRenderStart,
    parts,
    meshEntities,
    meshIdentity,
    heatmapRenderData,
    heatmapEntities,
    meshRenderData,
    rayPathEntities,
    renderScene,
    selectionMatches,
    xrayEnabled,
    geometryOpacity,
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
    publishCamera()
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
      position: direction.map((component, index) => target[index] + (component / directionLength) * distance),
      target: [...target],
      up: view === 'z' ? [0, 1, 0] : [0, 0, 1],
    })
    Object.assign(controlsRef.current, { phiDelta: 0, scale: 1, thetaDelta: 0 })
    if (view === 'default') fitCamera()
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

  const toolbar = {
    availableSources,
    meshMode: Boolean(meshRenderData) && parts.length === 0,
    pickMode,
    visibleSources,
    onPickModeChange: setPickMode,
    onSetCameraView: setCameraView,
    onToggleSource,
    onToggleViewerExpanded,
    onToggleXray: () => setXrayEnabled((current) => !current),
    viewerExpanded,
    xrayEnabled,
  }
  useLayoutEffect(() => {
    const token = cameraToken.current
    return () => savedCamera?.unregister(token)
  }, [savedCamera])
  useLayoutEffect(() => {
    savedCamera?.register(cameraToken.current, {
      apply: (pose) => {
        if (!cameraRef.current || !controlsRef.current) return
        Object.assign(cameraRef.current, pose)
        Object.assign(controlsRef.current, { phiDelta: 0, thetaDelta: 0, scale: 1 })
        cameraInitializedRef.current = true
        renderer.cameras.perspective.update(cameraRef.current, cameraRef.current)
        renderScene()
      },
      bounds: () => sceneBoundsRef.current,
      viewport: () => canvasRef.current?.parentElement?.getBoundingClientRect(),
      toolbar,
    })
  })

  return (
    <div className="flex h-full min-h-[320px] w-full flex-col overflow-hidden bg-slate-50 lg:min-h-0">
      {!savedCamera ? (
        <div data-capture-exclude>
          <ViewerToolbar {...toolbar} />
        </div>
      ) : null}

      <div aria-label="Geometry Viewer" className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {showScaleBar ? (
          <div
            className="pointer-events-none absolute bottom-4 left-4 z-10 rounded bg-white/90 px-3 py-2 text-center text-xs text-slate-800"
            title="카메라 중심 평면 기준 길이"
          >
            <div
              ref={scaleBarRef}
              aria-label="길이 Scale bar"
              className="min-h-6 border-x-2 border-b-2 border-slate-800"
            />
          </div>
        ) : null}
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
            if (lastPoint.button === 2) {
              const rect = event.currentTarget.getBoundingClientRect()
              Object.assign(
                cameraRef.current,
                panCamera({
                  aspect: cameraRef.current.aspect as number,
                  deltaX: dx,
                  deltaY: dy,
                  fov: cameraRef.current.fov as number,
                  height: rect.height,
                  position: cameraRef.current.position as number[],
                  target: cameraRef.current.target as number[],
                  up: cameraRef.current.up as number[],
                  width: rect.width,
                }),
              )
            } else {
              const controlChange = renderer.controls.orbit.rotate(
                { camera: cameraRef.current, controls: controlsRef.current, speed: 0.006 },
                [dx, dy],
              )
              Object.assign(cameraRef.current, controlChange.camera)
              Object.assign(controlsRef.current, controlChange.controls)
            }
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

        {parts.length === 0 && rayPathCount === 0 && !meshRenderData && !heatmapRenderData ? (
          <div
            data-viewer-empty="true"
            className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-slate-500"
          >
            {emptyMessage}
          </div>
        ) : null}

        {rayPathCount > 0 ? (
          <div className="pointer-events-none absolute bottom-3 left-3 rounded border border-slate-200 bg-white/90 px-3 py-2 text-xs text-slate-700 shadow-sm backdrop-blur-sm">
            Polylines · {rayPathCount.toLocaleString()} paths · {raySegmentCount.toLocaleString()} segments
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
