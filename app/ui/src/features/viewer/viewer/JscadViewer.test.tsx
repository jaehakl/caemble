import { CadViewer } from './CadViewer'
import { ComparisonToolbar } from './ComparisonToolbar'
import { createComparisonCamera } from './comparisonCamera'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { prepareRender } from '@jscad/regl-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import JscadViewer from './JscadViewer'
import {
  createComparisonSettings,
  ViewerComparisonContext,
  ViewerPersistenceContext,
  type ViewerComparison,
} from './comparisonSettings'
import { createRenderParts } from './renderParts'
import { primitives } from '@jscad/modeling'
import type { JscadViewerLayer } from './model'

const mocks = vi.hoisted(() => ({ draw: vi.fn(), render: vi.fn(), texture: vi.fn(() => ({ destroy: vi.fn() })) }))

vi.mock('@jscad/regl-renderer', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  return {
    ...original,
    ...original.default,
    prepareRender: vi.fn(
      (options: { drawCommands: Record<string, (regl: object, entity: object) => (props: object) => void> }) => {
        const drawCache = new Map<number, (props: object) => void>()
        const regl = Object.assign(
          vi.fn(() => mocks.draw),
          { prop: (name: string) => name, texture: mocks.texture, limits: { maxTextureSize: 2 } },
        )
        return (data: { entities?: { visuals: Record<string, unknown> }[] }) => {
          mocks.render(data)
          for (const entity of data.entities ?? []) {
            const { visuals } = entity
            const command = String(visuals.drawCmd ?? '')
            if (command !== 'drawHeatmap' && command !== 'drawHeatmapRaster') continue
            let drawCmd: ((props: object) => void) | undefined
            if (visuals.cacheId) drawCmd = drawCache.get(visuals.cacheId as number)
            else {
              visuals.cacheId = drawCache.size
              const buildDrawCommand = options.drawCommands[command]
              if (!buildDrawCommand) throw new Error(`Unknown draw command: ${command}`)
              drawCmd = buildDrawCommand(regl, entity)
              drawCache.set(visuals.cacheId as number, drawCmd)
            }
            drawCmd!({ ...entity, ...visuals })
          }
        }
      },
    ),
  }
})

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('selects Geometry and Surface locally, keeps missing paths, and clears through Viewer controls', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const layers: JscadViewerLayer[] = [
    {
      source: 'experiment',
      lengthUnit: 'm',
      parts: [
        {
          id: 'body',
          geometry: primitives.cuboid(),
          materialRole: 'body',
          surfaces: Array.from({ length: 6 }, (_, index) => ({
            id: `body/surface/${index}`,
            surfaceIndex: index,
            label: `Face ${index}`,
            polygonIndices: [index],
          })),
        },
      ],
      tree: { key: 'root', label: 'Geometry', children: [] },
    },
  ]
  const props = { lengthUnit: 'm' as const, onRenderStart: vi.fn(), onRenderEnd: vi.fn(), onRenderError: vi.fn() }
  const view = render(<JscadViewer {...props} layers={layers} />)
  const canvas = view.container.querySelector('canvas')!
  Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
  const clickCanvas = (x = 400, y = 300) => {
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: x, clientY: y })
    fireEvent.pointerUp(canvas, { button: 0, clientX: x, clientY: y })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Set z camera view' }))
  fireEvent.click(screen.getByRole('button', { name: 'Selection mode geometry' }))
  clickCanvas()
  expect(screen.getByRole('button', { name: 'Focus Viewer on body' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Find .* in Source/ })).not.toBeInTheDocument()

  view.rerender(<JscadViewer {...props} layers={[]} />)
  expect(screen.getByText('찾지 못함')).toBeInTheDocument()
  expect(screen.getByText('body')).toBeInTheDocument()
  view.rerender(<JscadViewer {...props} layers={layers} />)
  expect(screen.getByRole('button', { name: 'Focus Viewer on body' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Selection mode surface' }))
  clickCanvas()
  expect(screen.getByRole('button', { name: /^Focus Viewer on body\/surface\// })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Clear Viewer selection' }))
  expect(screen.queryByRole('button', { name: 'Clear Viewer selection' })).not.toBeInTheDocument()
  clickCanvas()
  expect(screen.getByRole('button', { name: 'Clear Viewer selection' })).toBeInTheDocument()
  clickCanvas(799, 599)
  expect(screen.queryByRole('button', { name: 'Clear Viewer selection' })).not.toBeInTheDocument()
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('shares pointer selection across comparison panes and retains it when either or both scenes disappear', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const camera = createComparisonCamera()
  const settings = createComparisonSettings()
  const comparison: ViewerComparison = {
    settings,
    camera,
    item: '',
    side: 'preview',
    controlsHost: null,
    controlsOwner: false,
    suspended: false,
  }
  const layer: JscadViewerLayer = {
    source: 'experiment',
    lengthUnit: 'm',
    parts: [{ id: 'body', geometry: primitives.cuboid(), materialRole: 'body', surfaces: [] }],
    tree: { key: 'root', label: 'Geometry', children: [] },
  }
  const props = { lengthUnit: 'm' as const, onRenderStart: vi.fn(), onRenderEnd: vi.fn(), onRenderError: vi.fn() }
  const content = (left: boolean, right: boolean, item = '') => (
    <>
      <ComparisonToolbar camera={camera} />
      <ViewerComparisonContext.Provider value={{ ...comparison, item }}>
        <JscadViewer {...props} key={`left:${item}`} layers={left ? [layer] : []} />
      </ViewerComparisonContext.Provider>
      <ViewerComparisonContext.Provider value={{ ...comparison, side: 'actual', item }}>
        <JscadViewer {...props} key={`right:${item}`} layers={right ? [layer] : []} />
      </ViewerComparisonContext.Provider>
    </>
  )
  const view = render(content(true, true))
  fireEvent.click(screen.getByRole('button', { name: 'Selection mode geometry' }))
  for (const canvas of view.container.querySelectorAll('canvas')) {
    Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 400, clientY: 300 })
    fireEvent.pointerUp(canvas, { button: 0, clientX: 400, clientY: 300 })
    expect(screen.getAllByRole('button', { name: 'Focus Viewer on body' })).toHaveLength(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear Viewer selection' })[0])
    expect(settings.selection.getSnapshot()).toBeNull()
  }
  act(() =>
    settings.selection.select({
      kind: 'geometry',
      match: 'exact',
      origin: 'viewer',
      scope: { source: 'experiment' },
      value: 'body',
    }),
  )
  view.rerender(content(false, true))
  expect(screen.getAllByRole('button', { name: 'Focus Viewer on body' })).toHaveLength(1)
  expect(screen.getAllByText('찾지 못함')).toHaveLength(1)
  view.rerender(content(false, false))
  expect(screen.getAllByText('찾지 못함')).toHaveLength(2)
  view.rerender(content(true, true, 'other-output'))
  expect(screen.getAllByRole('button', { name: 'Focus Viewer on body' })).toHaveLength(2)
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('keeps Geometry render work stable when only the scene wrapper and loading props change', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const scene = {
    lengthUnit: 'm' as const,
    parts: [{ id: 'body', geometry: primitives.cuboid(), materialRole: 'body', surfaces: [] }],
    tree: { key: 'root', label: 'Geometry', children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
  const onRenderEnd = vi.fn()
  const onRenderError = vi.fn()
  const onRenderStart = vi.fn()
  const props = { onRenderEnd, onRenderError, onRenderStart }
  const view = render(
    <div data-download-progress="0">
      <CadViewer {...props} experiment={{ scene, sceneHash: 'scene' }} />
    </div>,
  )
  const initialRenders = mocks.render.mock.calls.length
  expect(initialRenders).toBeGreaterThan(0)
  view.rerender(
    <div data-download-progress="1">
      <CadViewer {...props} experiment={{ scene, sceneHash: 'scene' }} selectionSourceStatus={{}} />
    </div>,
  )
  expect(mocks.render).toHaveBeenCalledTimes(initialRenders)

  const changedScene = { ...scene, parts: [{ ...scene.parts[0], geometry: primitives.cuboid({ size: [2, 2, 2] }) }] }
  view.rerender(
    <div data-download-progress="1">
      <CadViewer {...props} experiment={{ scene: changedScene, sceneHash: 'changed' }} />
    </div>,
  )
  expect(mocks.render.mock.calls.length).toBeGreaterThan(initialRenders)
  const changedRenders = mocks.render.mock.calls.length
  view.rerender(
    <div data-download-progress="1">
      <CadViewer {...props} experiment={{ scene: changedScene, sceneHash: 'changed' }} displayUnit="mm" />
    </div>,
  )
  expect(mocks.render.mock.calls.length).toBeGreaterThan(changedRenders)

  const taskScene = { ...scene, parts: [{ ...scene.parts[0], id: 'task' }] }
  view.rerender(
    <div data-download-progress="1">
      <CadViewer
        {...props}
        experiment={{
          scene: changedScene,
          sceneHash: 'changed',
          taskScenes: { trace: taskScene },
          taskSceneHashes: { trace: 'task' },
        }}
        displayUnit="mm"
      />
    </div>,
  )
  const taskRenders = mocks.render.mock.calls.length
  fireEvent.click(screen.getByRole('button', { name: 'Toggle task' }))
  expect(mocks.render.mock.calls.length).toBeGreaterThan(taskRenders)
  expect(onRenderError).not.toHaveBeenCalled()
})

it('rebuilds heatmap draw commands when StrictMode recreates the renderer', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const geometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint16Array([0, 1, 2]),
    primitive: 'triangles' as const,
  }
  const onRenderError = vi.fn()
  render(
    <StrictMode>
      <JscadViewer
        heatmapRenderData={{
          identity: 'heatmap',
          geometries: [geometry, geometry],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        }}
        layers={[]}
        lengthUnit="m"
        onRenderStart={vi.fn()}
        onRenderEnd={vi.fn()}
        onRenderError={onRenderError}
      />
    </StrictMode>,
  )
  expect(mocks.draw).toHaveBeenCalled()
  expect(onRenderError).not.toHaveBeenCalled()
})

it('registers recorded mesh and result chart commands as opaque depth-writing draws', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  render(
    <JscadViewer layers={[]} lengthUnit="m" onRenderStart={vi.fn()} onRenderEnd={vi.fn()} onRenderError={vi.fn()} />,
  )
  const regl = Object.assign(
    vi.fn(() => vi.fn()),
    { prop: (name: string) => name, texture: mocks.texture, limits: { maxTextureSize: 2 } },
  )
  const options = vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
    drawCommands: Record<string, (builder: typeof regl, entity: object) => unknown>
  }
  for (const command of ['drawRecordedMesh', 'drawHeatmap'] as const) {
    for (const primitive of ['triangles', 'lines']) {
      // regl-renderer passes the entity as the factory's second argument.
      options.drawCommands[command](regl, { primitive, visuals: { drawCmd: command } })
      expect(regl).toHaveBeenLastCalledWith(
        expect.objectContaining({
          blend: expect.objectContaining({ enable: false }),
          depth: { enable: true, func: 'lequal', mask: true },
        }),
      )
    }
  }
})

it('applies overlay opacity to Geometry fills and lets X-ray override it', () => {
  const part = {
    id: 'body',
    geometry: primitives.cuboid(),
    materialRole: 'body',
    surfaces: [],
  }
  const selection = new Map([['body', { geometry: true, polygonIndices: new Set<number>() }]])
  expect(createRenderParts([part], selection, false, false, 0.4)[0].color[3]).toBe(0.4)
  expect(createRenderParts([part], selection, true, false, 0.4)[0].color[3]).toBe(0)
  expect(createRenderParts([part], new Map(), false, false, 0.4)[0].edgeColor[3]).toBe(1)
})

it('rebuilds transparent Geometry entities without making the result chart transparent', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const chartGeometry = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    colors: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    indices: new Uint16Array([0, 1, 2]),
    primitive: 'triangles' as const,
  }
  const props = {
    layers: [
      {
        source: 'experiment' as const,
        lengthUnit: 'm' as const,
        parts: [{ id: 'body', geometry: primitives.cuboid(), materialRole: 'body', surfaces: [] }],
        tree: { key: 'root', label: 'Geometry', children: [] },
      },
    ],
    lengthUnit: 'm' as const,
    heatmapRenderData: {
      identity: 'chart',
      geometries: [chartGeometry],
      bounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    },
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
  }
  const view = render(<JscadViewer {...props} geometryOpacity={0.4} />)
  type TestEntity = {
    extras?: { depth: { mask: boolean } }
    geometry: { colors: ArrayLike<ArrayLike<number>> }
    visuals: { drawCmd: string; transparent: boolean }
  }
  const entities = () => mocks.render.mock.calls[mocks.render.mock.calls.length - 1]?.[0].entities as TestEntity[]
  const geometry = () => entities().find((entity) => entity.visuals.drawCmd === 'drawMesh')!
  const chart = () => entities().find((entity) => entity.visuals.drawCmd === 'drawHeatmap')!
  const geometryAlphas = () => Array.from(geometry().geometry.colors, (color) => color[3])
  expect(geometry().visuals.transparent).toBe(true)
  expect(geometry().extras?.depth.mask).toBe(false)
  expect(geometryAlphas().every((alpha) => Math.abs(alpha - 0.4) < 1e-6)).toBe(true)
  expect(chart().visuals.transparent).toBe(false)

  view.rerender(<JscadViewer {...props} geometryOpacity={0.2} />)
  expect(geometryAlphas().every((alpha) => Math.abs(alpha - 0.2) < 1e-6)).toBe(true)
  expect(screen.queryByRole('button', { name: 'Toggle X-ray' })).not.toBeInTheDocument()
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('keeps the camera when preflight mesh bounds and identity change', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    preserveCameraOnUpdate: true,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
    meshRenderData: {
      geometries: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      minimum: 0,
      maximum: 1,
      cut: Infinity,
    },
  }
  const { rerender } = render(<JscadViewer {...props} meshIdentity="first" />)
  const options = vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
    camera: { position: number[]; target: number[] }
  }
  options.camera.position = [7, 8, 9]
  options.camera.target = [1, 2, 3]
  const renderedBeforeUpdate = props.onRenderEnd.mock.calls.length
  rerender(
    <JscadViewer
      {...props}
      meshIdentity="second"
      meshRenderData={{ ...props.meshRenderData, bounds: { min: [0, 0, 0], max: [50, 50, 50] } }}
    />,
  )
  expect(Array.from(options.camera.position)).toEqual([7, 8, 9])
  expect(Array.from(options.camera.target)).toEqual([1, 2, 3])
  expect(props.onRenderError).not.toHaveBeenCalled()
  expect(props.onRenderEnd).toHaveBeenCalledTimes(renderedBeforeUpdate + 1)
})

it.each(['m', 'mm'] as const)('moves the %s camera by scale-bar wheel steps', (lengthUnit) => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const view = render(
    <JscadViewer
      layers={[]}
      lengthUnit={lengthUnit}
      onRenderStart={vi.fn()}
      onRenderEnd={vi.fn()}
      onRenderError={vi.fn()}
    />,
  )
  const canvas = view.container.querySelector('canvas')!
  let height = 600
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, get: () => height })
  const camera = (
    vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
      camera: { position: number[]; target: number[]; fov: number }
    }
  ).camera
  camera.fov = Math.PI / 2

  for (const { distance, viewportHeight, deltaY, ctrlKey, shiftKey, scaleLength, step } of [
    { distance: 10, viewportHeight: 600, deltaY: -1, ctrlKey: false, shiftKey: false, scaleLength: 2, step: 2 },
    { distance: 100, viewportHeight: 600, deltaY: -100, ctrlKey: false, shiftKey: false, scaleLength: 20, step: 20 },
    { distance: 10, viewportHeight: 1200, deltaY: -1, ctrlKey: false, shiftKey: false, scaleLength: 1, step: 1 },
    { distance: 10, viewportHeight: 600, deltaY: 1, ctrlKey: false, shiftKey: false, scaleLength: 2, step: -2 },
    { distance: 10, viewportHeight: 600, deltaY: -1, ctrlKey: true, shiftKey: false, scaleLength: 2, step: 0.2 },
    { distance: 10, viewportHeight: 600, deltaY: -1, ctrlKey: true, shiftKey: true, scaleLength: 2, step: 0.02 },
    { distance: 10, viewportHeight: 600, deltaY: -1, ctrlKey: false, shiftKey: true, scaleLength: 2, step: 20 },
  ]) {
    height = viewportHeight
    camera.position = [distance, 0, 0]
    camera.target = [0, 0, 0]
    fireEvent.wheel(canvas, { deltaY, ctrlKey, shiftKey })
    expect(camera.position[0]).toBeCloseTo(distance - step)
    expect(camera.target[0]).toBeCloseTo(-step)
    expect(camera.position[0] - camera.target[0]).toBeCloseTo(distance)
    expect(screen.getByLabelText('길이 Scale bar')).toHaveTextContent(`${scaleLength} ${lengthUnit}`)
  }

  height = 600
  camera.position = [10, 0, 0]
  camera.target = [0, 0, 0]
  for (let wheel = 0; wheel < 6; wheel++) fireEvent.wheel(canvas, { deltaY: -1 })
  expect(camera.position[0]).toBeCloseTo(-2)
  expect(camera.target[0]).toBeCloseTo(-12)
  fireEvent.wheel(canvas, { deltaY: -1 })
  expect(camera.position[0]).toBeCloseTo(-4)
  expect(camera.target[0]).toBeCloseTo(-14)
  const position = [...camera.position]
  const target = [...camera.target]
  fireEvent.wheel(canvas, { deltaY: 0 })
  expect(Array.from(camera.position)).toEqual(position)
  expect(Array.from(camera.target)).toEqual(target)
})

it('applies drag modifiers to rotation and panning without carrying over earlier rotation', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const view = render(
    <JscadViewer layers={[]} lengthUnit="m" onRenderStart={vi.fn()} onRenderEnd={vi.fn()} onRenderError={vi.fn()} />,
  )
  const canvas = view.container.querySelector('canvas')!
  Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
  const camera = (
    vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
      camera: { position: number[]; target: number[]; up: number[] }
    }
  ).camera

  for (const { ctrlKey, shiftKey, angle } of [
    { ctrlKey: false, shiftKey: false, angle: 0.06 },
    { ctrlKey: true, shiftKey: false, angle: 0.006 },
    { ctrlKey: true, shiftKey: true, angle: 0.0006 },
    { ctrlKey: false, shiftKey: true, angle: 0.6 },
  ]) {
    camera.position = [0, -10, 0]
    camera.target = [0, 0, 0]
    camera.up = [0, 0, 1]
    fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { buttons: 1, clientX: 110, clientY: 100, ctrlKey, shiftKey })
    fireEvent.pointerUp(canvas, { button: 0, clientX: 110, clientY: 100 })
    expect(Math.atan2(camera.position[0], -camera.position[1])).toBeCloseTo(angle, 5)
    expect(Array.from(camera.target)).toEqual([0, 0, 0])
  }

  camera.position = [0, -10, 0]
  camera.target = [0, 0, 0]
  camera.up = [0, 0, 1]
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 110, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 120, clientY: 100, ctrlKey: true })
  fireEvent.pointerUp(canvas, { button: 0, clientX: 120, clientY: 100 })
  expect(Math.atan2(camera.position[0], -camera.position[1])).toBeCloseTo(0.066, 5)

  camera.position = [3, -10, 5]
  camera.target = [2, -1, 1]
  camera.up = [0, 0, 1]
  const positionRadius = Math.hypot(...camera.position)
  const targetRadius = Math.hypot(...camera.target)
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 130, clientY: 120 })
  fireEvent.pointerUp(canvas, { button: 0, clientX: 130, clientY: 120 })
  expect(Math.hypot(...camera.position)).toBeCloseTo(positionRadius, 5)
  expect(Math.hypot(...camera.target)).toBeCloseTo(targetRadius, 5)
  expect(Array.from(camera.target)).not.toEqual([2, -1, 1])
  expect(camera.up[2]).toBeLessThan(1)

  let basePan = 0
  for (const { ctrlKey, shiftKey, multiplier } of [
    { ctrlKey: false, shiftKey: false, multiplier: 1 },
    { ctrlKey: true, shiftKey: false, multiplier: 0.1 },
    { ctrlKey: true, shiftKey: true, multiplier: 0.01 },
    { ctrlKey: false, shiftKey: true, multiplier: 10 },
  ]) {
    camera.position = [0, -10, 0]
    camera.target = [0, 0, 0]
    camera.up = [0, 0, 1]
    fireEvent.pointerDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(canvas, { buttons: 2, clientX: 130, clientY: 100, ctrlKey, shiftKey })
    fireEvent.pointerUp(canvas, { button: 2, clientX: 130, clientY: 100 })
    if (multiplier === 1) basePan = camera.position[0]
    expect(camera.position[0]).toBeCloseTo(basePan * multiplier, 5)
    expect(camera.target[0]).toBeCloseTo(basePan * multiplier, 5)
  }
})

it('fits delayed small geometry instead of saving the empty initial camera, including StrictMode', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const comparison: ViewerComparison = {
    settings: createComparisonSettings(),
    item: '',
    side: 'preview',
    controlsHost: null,
    controlsOwner: true,
    suspended: false,
    camera: createComparisonCamera(),
  }
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
  }
  const empty = render(
    <StrictMode>
      <ViewerComparisonContext.Provider value={comparison}>
        <JscadViewer {...props} />
      </ViewerComparisonContext.Provider>
    </StrictMode>,
  )
  empty.unmount()
  expect(comparison.camera.current).toBeNull()
  const view = render(
    <StrictMode>
      <ViewerComparisonContext.Provider value={comparison}>
        <JscadViewer {...props} />
      </ViewerComparisonContext.Provider>
    </StrictMode>,
  )
  view.rerender(
    <StrictMode>
      <ViewerComparisonContext.Provider value={comparison}>
        <JscadViewer
          {...props}
          meshIdentity="loaded"
          meshRenderData={{
            geometries: [],
            bounds: { min: [0.004, 0.002, 0.001], max: [0.005, 0.003, 0.002] },
            minimum: 0,
            maximum: 1,
            cut: Infinity,
          }}
        />
      </ViewerComparisonContext.Provider>
    </StrictMode>,
  )
  const camera = (
    vi.mocked(prepareRender).mock.calls.slice(-1)[0]![0] as unknown as {
      camera: { position: number[]; target: number[] }
    }
  ).camera
  expect(Array.from(camera.target)).toEqual([0.0045000000000000005, 0.0025, 0.0015])
  expect(Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))).toBeLessThan(0.01)
  view.unmount()
  expect(comparison.camera.current).not.toBeNull()
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('defers fit until a hidden viewport is visible and preserves the camera on later resize', () => {
  let width = 0
  const callbacks: Array<() => void> = []
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
    () => new DOMRect(0, 0, width, width ? 600 : 0),
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        callbacks.push(callback)
      }
      observe() {}
      disconnect() {}
    },
  )
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    preserveCameraOnUpdate: true,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
    meshRenderData: {
      geometries: [],
      bounds: { min: [3, 4, 5], max: [4, 5, 6] },
      minimum: 0,
      maximum: 1,
      cut: Infinity,
    },
  }
  render(<JscadViewer {...props} />)
  const camera = (
    vi.mocked(prepareRender).mock.calls.slice(-1)[0]![0] as unknown as {
      camera: { position: number[]; target: number[] }
    }
  ).camera
  expect(Array.from(camera.target)).toEqual([0, 0, 0])
  act(() => {
    width = 200
    callbacks.forEach((callback) => callback())
  })
  expect(Array.from(camera.target)).toEqual([3.5, 4.5, 5.5])
  const fittedPosition = Array.from(camera.position)
  act(() => {
    width = 400
    callbacks.forEach((callback) => callback())
  })
  expect(Array.from(camera.position)).toEqual(fittedPosition)
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('uses the current content center and size when the user requests full fit', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    preserveCameraOnUpdate: true,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
    meshRenderData: {
      geometries: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      minimum: 0,
      maximum: 1,
      cut: Infinity,
    },
  }
  const view = render(<JscadViewer {...props} />)
  const camera = (
    vi.mocked(prepareRender).mock.calls.slice(-1)[0]![0] as unknown as {
      camera: { position: number[]; target: number[] }
    }
  ).camera
  camera.position = [100, 100, 100]
  camera.target = [50, 50, 50]
  view.rerender(
    <JscadViewer {...props} meshRenderData={{ ...props.meshRenderData, bounds: { min: [3, 4, 5], max: [4, 5, 6] } }} />,
  )
  expect(Array.from(camera.position)).toEqual([100, 100, 100])
  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expect(Array.from(camera.target)).toEqual([3.5, 4.5, 5.5])
  expect(Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))).toBeLessThan(10)
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('rotates around the selected Geometry center and fits its bounds only on button click', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const layers = [
    {
      source: 'experiment' as const,
      lengthUnit: 'm' as const,
      parts: [
        {
          id: 'chosen',
          geometry: primitives.cuboid({ center: [10, 0, 0], size: [2, 2, 2] }),
          materialRole: 'body',
          surfaces: [],
        },
        {
          id: 'other',
          geometry: primitives.cuboid({ center: [-10, 0, 0], size: [2, 2, 2] }),
          materialRole: 'body',
          surfaces: [],
        },
      ],
      tree: { key: 'root', label: 'Geometry', children: [] },
    },
  ]
  const selectionQuery = {
    kind: 'geometry',
    match: 'exact',
    origin: 'code',
    scope: { source: 'experiment' },
    value: 'chosen',
  } as const
  const props = {
    layers,
    lengthUnit: 'm' as const,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
  }
  const persistent = { settings: createComparisonSettings(), camera: createComparisonCamera(), item: '' }
  persistent.settings.selection.selectFromCode(selectionQuery)
  const view = render(
    <ViewerPersistenceContext.Provider value={persistent}>
      <JscadViewer {...props} />
    </ViewerPersistenceContext.Provider>,
  )
  const camera = (
    vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
      camera: { position: number[]; target: number[]; up: number[] }
    }
  ).camera
  expect(camera.target[0]).toBeCloseTo(0)

  const canvas = view.container.querySelector('canvas')!
  Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
  camera.position = [0, -20, 0]
  camera.target = [0, 0, 0]
  camera.up = [0, 0, 1]
  const pivot = [10, 0, 0]
  const radius = Math.hypot(...camera.position.map((value, axis) => value - pivot[axis]))
  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 130, clientY: 120 })
  fireEvent.pointerUp(canvas, { button: 0, clientX: 130, clientY: 120 })
  expect(Math.hypot(...camera.position.map((value, axis) => value - pivot[axis]))).toBeCloseTo(radius, 5)
  expect(Math.hypot(...camera.position)).not.toBeCloseTo(20, 2)

  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expect(camera.target).toEqual([10, 0, 0])
  const selectedDistance = Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))
  act(() => persistent.settings.selection.select(null))
  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expect(camera.target).toEqual([0, 0, 0])
  expect(Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))).toBeGreaterThan(
    selectedDistance,
  )
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('fits selected Geometry across comparison viewers with different layer units', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const camera = createComparisonCamera()
  const comparison: ViewerComparison = {
    settings: createComparisonSettings(),
    item: '',
    side: 'preview',
    controlsHost: null,
    controlsOwner: false,
    suspended: false,
    camera,
  }
  const selected = {
    kind: 'geometry',
    match: 'exact',
    origin: 'code',
    scope: { source: 'experiment' },
    value: 'chosen',
  } as const
  comparison.settings.selection.selectFromCode(selected)
  const props = { lengthUnit: 'm' as const, onRenderStart: vi.fn(), onRenderEnd: vi.fn(), onRenderError: vi.fn() }
  const layers = (lengthUnit: 'm' | 'mm', center: number) => [
    {
      source: 'experiment' as const,
      lengthUnit,
      parts: [
        {
          id: 'chosen',
          geometry: primitives.cuboid({
            center: [center, 0, 0],
            size: lengthUnit === 'mm' ? [2000, 2000, 2000] : [2, 2, 2],
          }),
          materialRole: 'body',
          surfaces: [],
        },
        {
          id: 'other',
          geometry: primitives.cuboid({ center: [center + 100000, 0, 0] }),
          materialRole: 'body',
          surfaces: [],
        },
      ],
      tree: { key: 'root', label: 'Geometry', children: [] },
    },
  ]
  render(
    <>
      <ComparisonToolbar camera={camera} />
      <ViewerComparisonContext.Provider value={comparison}>
        <JscadViewer {...props} layers={layers('m', 1)} />
      </ViewerComparisonContext.Provider>
      <ViewerComparisonContext.Provider value={{ ...comparison, side: 'actual' }}>
        <JscadViewer {...props} layers={layers('mm', 5000)} />
      </ViewerComparisonContext.Provider>
    </>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expect(camera.current?.target[0]).toBeCloseTo(3)
  expect(camera.current?.target.slice(1)).toEqual([0, 0])
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it.each(['x', 'y', 'z'] as const)('toggles the %s camera view across its axis', (viewName) => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const view = render(
    <JscadViewer layers={[]} lengthUnit="m" onRenderStart={vi.fn()} onRenderEnd={vi.fn()} onRenderError={vi.fn()} />,
  )
  const canvas = view.container.querySelector('canvas')!
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 600 })
  const camera = (
    vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
      camera: { position: number[]; target: number[]; up: number[] }
    }
  ).camera
  camera.position = [8, 9, 10]
  camera.target = [1, 2, 3]
  const initialTarget = [...camera.target]
  const distance = Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))
  const axis = { x: 0, y: 1, z: 2 }[viewName]
  const button = () => screen.getByRole('button', { name: `Set ${viewName} camera view` })
  const expectDirection = (sign: number) => {
    camera.position.forEach((value, index) =>
      expect(value - camera.target[index]).toBeCloseTo(index === axis ? sign * distance : 0, 4),
    )
    expect(camera.up).toEqual(viewName === 'z' ? [0, 1, 0] : [0, 0, 1])
  }

  fireEvent.click(button())
  expectDirection(1)
  expect(Array.from(camera.target)).toEqual(initialTarget)
  fireEvent.click(button())
  expectDirection(-1)
  fireEvent.click(button())
  expectDirection(1)

  fireEvent.wheel(canvas, { deltaY: -1 })
  const movedTarget = [...camera.target]
  expect(movedTarget).not.toEqual(initialTarget)
  fireEvent.click(button())
  expectDirection(-1)
  expect(Array.from(camera.target)).toEqual(movedTarget)

  fireEvent.click(screen.getByRole('button', { name: `Set ${viewName === 'x' ? 'y' : 'x'} camera view` }))
  fireEvent.click(button())
  expectDirection(1)
})

it('keeps an axis toggle after panning and starts from the positive side after free rotation', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const view = render(
    <JscadViewer layers={[]} lengthUnit="m" onRenderStart={vi.fn()} onRenderEnd={vi.fn()} onRenderError={vi.fn()} />,
  )
  const canvas = view.container.querySelector('canvas')!
  Object.assign(canvas, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
  const camera = (
    vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
      camera: { position: number[]; target: number[] }
    }
  ).camera
  const button = screen.getByRole('button', { name: 'Set x camera view' })
  fireEvent.click(button)
  const distance = Math.hypot(...camera.position.map((value, axis) => value - camera.target[axis]))

  fireEvent.pointerDown(canvas, { button: 2, buttons: 2, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 2, clientX: 130, clientY: 100 })
  fireEvent.pointerUp(canvas, { button: 2, clientX: 130, clientY: 100 })
  const pannedTarget = [...camera.target]
  fireEvent.click(button)
  expect(camera.position[0] - camera.target[0]).toBeCloseTo(-distance, 4)
  expect(Array.from(camera.target)).toEqual(pannedTarget)

  fireEvent.pointerDown(canvas, { button: 0, buttons: 1, clientX: 100, clientY: 100 })
  fireEvent.pointerMove(canvas, { buttons: 1, clientX: 130, clientY: 100 })
  fireEvent.pointerUp(canvas, { button: 0, clientX: 130, clientY: 100 })
  expect(Math.abs(camera.position[1] - camera.target[1])).toBeGreaterThan(0.01)
  const rotatedTarget = [...camera.target]
  fireEvent.click(button)
  expect(camera.position[0] - camera.target[0]).toBeCloseTo(distance, 4)
  expect(Array.from(camera.target)).toEqual(rotatedTarget)
})

it('shares camera gestures and one toolbar, preserving the pose through late mount and result replacement', () => {
  const resizeCallbacks: (() => void)[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1
    },
  )
  const camera = createComparisonCamera()
  const preview: ViewerComparison = {
    settings: createComparisonSettings(),
    item: 'signal',
    side: 'preview',
    controlsHost: null,
    controlsOwner: false,
    suspended: false,
    camera,
  }
  const actual: ViewerComparison = { ...preview, side: 'actual' }
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
    meshRenderData: {
      geometries: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      minimum: 0,
      maximum: 1,
      cut: Infinity,
    },
  }
  const content = (showActual: boolean, result = 'first') => (
    <StrictMode>
      <ComparisonToolbar camera={camera} />
      <ViewerComparisonContext.Provider value={preview}>
        <JscadViewer {...props} key={`preview:${result}`} meshIdentity={result} />
      </ViewerComparisonContext.Provider>
      {showActual && (
        <ViewerComparisonContext.Provider value={actual}>
          <JscadViewer
            {...props}
            key={`actual:${result}`}
            meshIdentity={result}
            meshRenderData={{ ...props.meshRenderData, bounds: { min: [10, 0, 0], max: [12, 2, 2] } }}
          />
        </ViewerComparisonContext.Provider>
      )}
    </StrictMode>
  )
  const view = render(content(false))
  const canvas = view.container.querySelector('canvas')!
  fireEvent.wheel(canvas, { deltaY: -1 })
  const beforeLateMount = structuredClone(camera.current)
  view.rerender(content(true))
  expect(camera.current).toEqual(beforeLateMount)
  expect(screen.getAllByRole('button', { name: 'Set x camera view' })).toHaveLength(1)
  const cameraObjects = () =>
    vi.mocked(prepareRender).mock.calls.map(
      ([options]) =>
        (
          options as unknown as {
            camera: { position: number[]; target: number[]; up: number[]; fov: number; aspect: number }
          }
        ).camera,
    )
  const activeCameras = [cameraObjects()[1], cameraObjects().slice(-1)[0]!]
  const expectSynchronized = () => {
    for (const current of activeCameras) {
      current.position.forEach((value, axis) => expect(value).toBeCloseTo(camera.current!.position[axis], 5))
      expect(Array.from(current.target)).toEqual(camera.current!.target)
    }
  }
  expectSynchronized()
  const canvases = Array.from(view.container.querySelectorAll('canvas'))
  for (const target of canvases) {
    Object.assign(target, { setPointerCapture: vi.fn(), hasPointerCapture: () => false })
    for (const button of [0, 2]) {
      const before = structuredClone(camera.current)
      fireEvent.pointerDown(target, { button, buttons: button === 2 ? 2 : 1, clientX: 100, clientY: 100 })
      fireEvent.pointerMove(target, { buttons: button === 2 ? 2 : 1, clientX: 130, clientY: 120 })
      fireEvent.pointerUp(target, { button, clientX: 130, clientY: 120 })
      expect(camera.current).not.toEqual(before)
      expectSynchronized()
    }
    fireEvent.wheel(target, { deltaY: -1 })
    expectSynchronized()
  }
  for (const direction of ['x', 'y', 'z']) {
    fireEvent.click(screen.getByRole('button', { name: `Set ${direction} camera view` }))
    expectSynchronized()
    fireEvent.click(screen.getByRole('button', { name: `Set ${direction} camera view` }))
    expectSynchronized()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expectSynchronized()
  expect(camera.current!.target).toEqual([6, 1, 1])
  const beforeResize = structuredClone(camera.current)
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 250, 600))
  act(() => resizeCallbacks.forEach((callback) => callback()))
  expect(camera.current).toEqual(beforeResize)
  fireEvent.click(screen.getByRole('button', { name: 'Set default camera view' }))
  expectSynchronized()
  const finalPose = structuredClone(camera.current)
  view.rerender(content(true, 'updated'))
  expect(camera.current).toEqual(finalPose)
  expect(camera.getSnapshot()).toHaveLength(2)
  expect(props.onRenderError).not.toHaveBeenCalled()
  view.unmount()
  expect(camera.getSnapshot()).toHaveLength(0)
  expect(camera.current).toEqual(finalPose)
})

it('shares Geometry selection, selection mode and Task visibility', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const camera = createComparisonCamera()
  const preview: ViewerComparison = {
    settings: createComparisonSettings(),
    item: '',
    side: 'preview',
    controlsHost: null,
    controlsOwner: false,
    suspended: false,
    camera,
  }
  const actual: ViewerComparison = { ...preview, side: 'actual' }
  preview.settings.selection.selectFromCode({
    kind: 'geometry',
    match: 'exact',
    origin: 'code',
    scope: { source: 'experiment' },
    value: 'body',
  })
  const scene = {
    lengthUnit: 'm' as const,
    parts: [{ id: 'body', geometry: primitives.cuboid({ center: [3, 0, 0] }), materialRole: 'body', surfaces: [] }],
    tree: { key: 'root', label: 'Geometry', children: [] },
    geometryGroups: [],
    surfaceGroups: [],
  }
  const props = { onRenderStart: vi.fn(), onRenderEnd: vi.fn(), onRenderError: vi.fn() }
  const content = (item: string) => (
    <>
      <ComparisonToolbar camera={camera} />
      <ViewerComparisonContext.Provider value={{ ...preview, item }}>
        <CadViewer {...props} experiment={{ scene }} />
      </ViewerComparisonContext.Provider>
      <ViewerComparisonContext.Provider value={{ ...actual, item }}>
        <CadViewer {...props} experiment={{ scene, taskScenes: { other: scene } }} />
      </ViewerComparisonContext.Provider>
    </>
  )
  const view = render(content(''))
  expect(screen.queryByRole('button', { name: 'Toggle X-ray' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Toggle experiment' })).not.toBeInTheDocument()
  const canvases = view.container.querySelectorAll('canvas')
  fireEvent.click(screen.getByRole('button', { name: 'Selection mode geometry' }))
  for (const canvas of canvases) expect(canvas.className).toContain('cursor-crosshair')
  expect(screen.getAllByRole('button', { name: 'Focus Viewer on body' })).toHaveLength(2)
  fireEvent.click(screen.getAllByRole('button', { name: 'Focus Viewer on body' })[0])
  const cameras = vi
    .mocked(prepareRender)
    .mock.calls.slice(-2)
    .map(([options]) => (options as unknown as { camera: { position: number[]; target: number[] } }).camera)
  for (const current of cameras) {
    expect(Array.from(current.target)).toEqual(camera.current!.target)
    current.position.forEach((value, axis) => expect(value).toBeCloseTo(camera.current!.position[axis], 5))
  }
  // Task exists only in the second pane, but the common control must remain usable.
  fireEvent.click(screen.getByRole('button', { name: 'Toggle task' }))
  expect(screen.getByRole('button', { name: 'Toggle task' })).toHaveAttribute('aria-pressed', 'false')
  view.rerender(content('other-result'))
  expect(screen.getByRole('button', { name: 'Toggle task' })).toHaveAttribute('aria-pressed', 'false')
  for (const canvas of canvases) expect(canvas.className).toContain('cursor-crosshair')
  expect(props.onRenderError).not.toHaveBeenCalled()
})

it('tiles nearest textures, refreshes their data, and releases them on view changes and StrictMode cleanup', () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  const raster = {
    width: 3,
    height: 3,
    rgba: new Uint8Array(36).fill(255),
    origin: [1, 2, 3],
    columnVector: [3, 0, 0],
    rowVector: [0, 3, 0],
  }
  const props = {
    layers: [],
    lengthUnit: 'm' as const,
    onRenderStart: vi.fn(),
    onRenderEnd: vi.fn(),
    onRenderError: vi.fn(),
  }
  const data = { identity: 'raster', geometries: [], raster, bounds: { min: [1, 2, 3], max: [4, 5, 3] } }
  const view = render(
    <StrictMode>
      <JscadViewer {...props} heatmapRenderData={data} />
    </StrictMode>,
  )
  expect(props.onRenderError).not.toHaveBeenCalled()
  const textures = () => mocks.texture.mock.results.map((result) => result.value)
  expect(textures().filter((texture) => !texture.destroy.mock.calls.length)).toHaveLength(4)
  expect(mocks.texture).toHaveBeenCalledWith(expect.objectContaining({ min: 'nearest', mag: 'nearest', flipY: false }))
  expect(mocks.draw).toHaveBeenCalledWith(
    expect.objectContaining({
      positions: [
        [3, 4, 3],
        [4, 4, 3],
        [4, 5, 3],
        [3, 5, 3],
      ],
    }),
  )
  const old = textures()
  view.rerender(
    <StrictMode>
      <JscadViewer {...props} heatmapRenderData={{ ...data, raster: { ...raster, rgba: new Uint8Array(36) } }} />
    </StrictMode>,
  )
  for (const texture of old) expect(texture.destroy).toHaveBeenCalledTimes(1)
  expect(textures().filter((texture) => !texture.destroy.mock.calls.length)).toHaveLength(4)
  view.rerender(
    <StrictMode>
      <JscadViewer {...props} />
    </StrictMode>,
  )
  for (const texture of textures()) expect(texture.destroy).toHaveBeenCalledTimes(1)
  view.rerender(
    <StrictMode>
      <JscadViewer {...props} heatmapRenderData={data} />
    </StrictMode>,
  )
  expect(textures().filter((texture) => !texture.destroy.mock.calls.length)).toHaveLength(4)
  view.unmount()
  for (const texture of textures()) expect(texture.destroy).toHaveBeenCalledTimes(1)
  expect(props.onRenderError).not.toHaveBeenCalled()
})
