import { render } from '@testing-library/react'
import { prepareRender } from '@jscad/regl-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import JscadViewer from './JscadViewer'

const mocks = vi.hoisted(() => ({ draw: vi.fn() }))

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

afterEach(() => {
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

it('registers opaque mesh and transparent heatmap commands with the renderer entity argument', () => {
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
  for (const [command, transparent] of [
    ['drawRecordedMesh', false],
    ['drawHeatmap', true],
  ] as const) {
    for (const primitive of ['triangles', 'lines']) {
      // regl-renderer passes the entity as the factory's second argument.
      options.drawCommands[command](regl, { primitive, visuals: { drawCmd: command } })
      expect(regl).toHaveBeenLastCalledWith(
        expect.objectContaining({
          blend: expect.objectContaining({ enable: transparent }),
          depth: { enable: true, func: 'lequal', mask: !transparent },
        }),
      )
    }
  }
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
  expect(props.onRenderEnd).toHaveBeenCalledTimes(2)
})
