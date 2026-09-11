import { render } from '@testing-library/react'
import { prepareRender } from '@jscad/regl-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import JscadViewer from './JscadViewer'

vi.mock('@jscad/regl-renderer', async (importOriginal) => {
  const original = await importOriginal<{ default: object }>()
  return { ...original, ...original.default, prepareRender: vi.fn(() => vi.fn()) }
})

afterEach(() => vi.unstubAllGlobals())

it('registers opaque mesh and transparent heatmap commands with the renderer entity argument', () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  render(
    <JscadViewer
      layers={[]}
      lengthUnit="m"
      onRenderStart={vi.fn()}
      onRenderEnd={vi.fn()}
      onRenderError={vi.fn()}
    />,
  )
  const regl = Object.assign(vi.fn(() => vi.fn()), { prop: (name: string) => name })
  const options = vi.mocked(prepareRender).mock.calls[0][0] as unknown as {
    drawCommands: Record<string, (builder: typeof regl, entity: object) => unknown>
  }
  for (const [command, transparent] of [['drawRecordedMesh', false], ['drawHeatmap', true]] as const) {
    for (const primitive of ['triangles', 'lines']) {
      // regl-renderer passes the entity as the factory's second argument.
      options.drawCommands[command](regl, { primitive, visuals: { drawCmd: command } })
      expect(regl).toHaveBeenLastCalledWith(expect.objectContaining({
        blend: expect.objectContaining({ enable: transparent }),
        depth: { enable: true, func: 'lequal', mask: !transparent },
      }))
    }
  }
})


it('keeps the camera when preflight mesh bounds and identity change', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const props = { layers: [], lengthUnit: 'm' as const, preserveCameraOnUpdate: true,
    onRenderStart: vi.fn(), onRenderEnd: vi.fn(), onRenderError: vi.fn(),
    meshRenderData: { geometries: [], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, minimum: 0, maximum: 1, cut: Infinity },
  }
  const { rerender } = render(<JscadViewer {...props} meshIdentity="first" />)
  const options = vi.mocked(prepareRender).mock.calls[0][0] as unknown as { camera: { position: number[]; target: number[] } }
  options.camera.position = [7, 8, 9]
  options.camera.target = [1, 2, 3]
  rerender(<JscadViewer {...props} meshIdentity="second" meshRenderData={{ ...props.meshRenderData, bounds: { min: [0, 0, 0], max: [50, 50, 50] } }} />)
  expect(Array.from(options.camera.position)).toEqual([7, 8, 9])
  expect(Array.from(options.camera.target)).toEqual([1, 2, 3])
  expect(props.onRenderError).not.toHaveBeenCalled()
  expect(props.onRenderEnd).toHaveBeenCalledTimes(2)
})
