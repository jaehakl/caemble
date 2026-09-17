import { CadViewer } from './CadViewer'
import { ComparisonToolbar } from './ComparisonToolbar'
import { createComparisonCamera } from './comparisonCamera'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { prepareRender } from '@jscad/regl-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import JscadViewer from './JscadViewer'
import { createComparisonSettings, ViewerComparisonContext, type ViewerComparison } from './comparisonSettings'
import { createRenderParts } from './renderParts'
import { primitives } from '@jscad/modeling'

const mocks = vi.hoisted(() => ({ draw: vi.fn(), render: vi.fn() }))

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
          { prop: (name: string) => name },
        )
        return (data: { entities?: { visuals: Record<string, unknown> }[] }) => {
          mocks.render(data)
          for (const entity of data.entities ?? []) {
            const { visuals } = entity
            const command = String(visuals.drawCmd ?? '')
            if (command !== 'drawHeatmap') continue
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
    { prop: (name: string) => name },
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
  fireEvent.click(screen.getByRole('button', { name: 'Toggle X-ray' }))
  expect(geometryAlphas().every((alpha) => alpha === 0)).toBe(true)
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
  for (const direction of ['x', 'y', 'z', 'default']) {
    fireEvent.click(screen.getByRole('button', { name: `Set ${direction} camera view` }))
    expectSynchronized()
  }
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

it('shares X-ray, selection mode and source visibility while keeping selection focus local', () => {
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
        <CadViewer
          {...props}
          experiment={{ scene }}
          selectionQuery={{
            kind: 'geometry',
            match: 'exact',
            origin: 'code',
            scope: { source: 'experiment' },
            value: 'body',
          }}
        />
      </ViewerComparisonContext.Provider>
      <ViewerComparisonContext.Provider value={{ ...actual, item }}>
        <CadViewer {...props} experiment={{ scene, taskScenes: { other: scene } }} />
      </ViewerComparisonContext.Provider>
    </>
  )
  const view = render(content(''))
  expect(screen.getAllByRole('button', { name: 'Toggle X-ray' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Toggle X-ray' }))
  expect(screen.getByRole('button', { name: 'Toggle X-ray' })).toHaveAttribute('aria-pressed', 'true')
  const canvases = view.container.querySelectorAll('canvas')
  fireEvent.click(screen.getByRole('button', { name: 'Selection mode geometry' }))
  for (const canvas of canvases) expect(canvas.className).toContain('cursor-crosshair')
  expect(screen.getAllByRole('button', { name: 'Focus Viewer on body' })).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: 'Focus Viewer on body' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
  expect(screen.getAllByText('All Experiment geometry layers are hidden.')).toHaveLength(2)
  view.rerender(content('other-result'))
  expect(screen.getAllByText('All Experiment geometry layers are hidden.')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Toggle X-ray' })).toHaveAttribute('aria-pressed', 'true')
  for (const canvas of canvases) expect(canvas.className).toContain('cursor-crosshair')
  expect(props.onRenderError).not.toHaveBeenCalled()
})
