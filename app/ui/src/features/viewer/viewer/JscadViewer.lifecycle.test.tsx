// @vitest-environment jsdom

import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RayPathBundle } from '@/lib/cad'
import JscadViewer from './JscadViewer'

const rendererMocks = vi.hoisted(() => {
  const renderScene = vi.fn()
  return {
    entitiesFromSolids: vi.fn((_options: unknown, geometry: unknown) => [
      {
        geometry,
        visuals: { drawCmd: 'drawMesh', show: true },
      },
    ]),
    prepareRender: vi.fn(() => renderScene),
    renderScene,
  }
})

vi.mock('@jscad/regl-renderer', () => ({
  cameras: {
    perspective: {
      defaults: { position: [10, 10, 10], target: [0, 0, 0], up: [0, 1, 0] },
      setProjection: vi.fn((output: unknown) => output),
      update: vi.fn((output: unknown) => output),
    },
  },
  controls: {
    orbit: {
      defaults: {},
      pan: vi.fn((state: unknown) => state),
      rotate: vi.fn((state: unknown) => state),
      update: vi.fn((state: unknown) => state),
      zoom: vi.fn((state: unknown) => state),
      zoomToFit: vi.fn((state: unknown) => state),
    },
  },
  drawCommands: { drawAxis: {}, drawGrid: {}, drawLines: {}, drawMesh: {} },
  entitiesFromSolids: rendererMocks.entitiesFromSolids,
  prepareRender: rendererMocks.prepareRender,
}))

const coloredLayer = {
  source: 'experiment' as const,
  lengthUnit: 'mm' as const,
  parts: [
    {
      id: 'part',
      geometry: {},
      materialRole: 'body',
      material: { name: 'Copper', variables: { color: '#a1b2c3' } },
      surfaces: [],
    },
  ],
  sceneHash: 'same-scene',
}

const rayPathBundle: RayPathBundle = {
  id: 'primary',
  pathCount: 1,
  segmentCount: 1,
  vertices: new Float32Array([0, 0, 0, 1, 0, 0]),
  pathOffsets: new Uint32Array([0, 2]),
  segmentPower: new Float32Array([1]),
  pathWavelength: new Float32Array([532e-9]),
  segmentEvent: new Uint8Array([5]),
}

describe('JscadViewer geometry lifecycle', () => {
  beforeEach(() => {
    rendererMocks.entitiesFromSolids.mockClear()
    rendererMocks.prepareRender.mockReset()
    rendererMocks.prepareRender.mockImplementation(() => rendererMocks.renderScene)
    rendererMocks.renderScene.mockClear()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function mockRendererEntityMutation() {
    rendererMocks.prepareRender.mockImplementation(() => {
      const drawCache = new Map<number, () => void>()
      return vi.fn((options: unknown) => {
        const entities =
          (
            options as {
              entities?: { visuals?: { cacheId?: number; drawCmd?: string } }[]
            }
          ).entities ?? []
        entities.forEach((entity) => {
          const visuals = entity.visuals
          if (!visuals?.drawCmd) return

          let drawCommand = visuals.cacheId ? drawCache.get(visuals.cacheId) : undefined
          if (!visuals.cacheId) {
            visuals.cacheId = drawCache.size
            drawCommand = vi.fn()
            drawCache.set(visuals.cacheId, drawCommand)
          }
          if (!drawCommand) throw new TypeError('drawCmd is not a function')
          drawCommand()
        })
      })
    })
  }

  it('opens an empty Viewer when StrictMode creates a second renderer session', async () => {
    mockRendererEntityMutation()
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }

    render(
      <StrictMode>
        <JscadViewer layers={[]} lengthUnit="mm" {...callbacks} />
      </StrictMode>,
    )

    await waitFor(() => expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(2))
    expect(callbacks.onRenderError).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Geometry Viewer')).toBeInTheDocument()
    expect(screen.getByText('Waiting for model...')).toBeInTheDocument()
  })

  it('rebuilds ray-path commands for a second StrictMode renderer session', async () => {
    mockRendererEntityMutation()
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }

    render(
      <StrictMode>
        <JscadViewer layers={[]} lengthUnit="m" rayPaths={[rayPathBundle]} {...callbacks} />
      </StrictMode>,
    )

    await waitFor(() => expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(2))
    expect(callbacks.onRenderError).not.toHaveBeenCalled()
    expect(screen.getByText('Ray paths · 1 paths · 1 segments')).toBeInTheDocument()
  })

  it('rebuilds Geometry entities for a second StrictMode renderer session', async () => {
    mockRendererEntityMutation()
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }

    render(
      <StrictMode>
        <JscadViewer layers={[coloredLayer]} lengthUnit="mm" {...callbacks} />
      </StrictMode>,
    )

    await waitFor(() => expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(2))
    expect(rendererMocks.entitiesFromSolids).toHaveBeenCalledTimes(2)
    expect(callbacks.onRenderEnd).toHaveBeenCalled()
    expect(callbacks.onRenderError).not.toHaveBeenCalled()
  })

  it('keeps the Viewer mounted when a renderer command fails', async () => {
    rendererMocks.prepareRender.mockImplementation(() =>
      vi.fn(() => {
        throw new TypeError('drawCmd is not a function')
      }),
    )
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }

    render(<JscadViewer layers={[]} lengthUnit="mm" {...callbacks} />)

    await waitFor(() => expect(callbacks.onRenderError).toHaveBeenCalledWith('drawCmd is not a function'))
    expect(screen.getByLabelText('Geometry Viewer')).toBeInTheDocument()
    expect(screen.getByText('Waiting for model...')).toBeInTheDocument()
  })

  it('renders Geometry, reports its lifecycle, and keeps camera and source controls interactive', async () => {
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }
    const onToggleSource = vi.fn()
    render(
      <JscadViewer
        availableSources={['experiment']}
        layers={[coloredLayer]}
        lengthUnit="mm"
        visibleSources={['experiment']}
        {...callbacks}
        onToggleSource={onToggleSource}
      />,
    )

    await waitFor(() => expect(callbacks.onRenderEnd).toHaveBeenCalledOnce())
    expect(callbacks.onRenderStart).toHaveBeenCalledOnce()
    expect(callbacks.onRenderError).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Geometry Viewer')).toBeInTheDocument()

    const rendersBeforeCameraChange = rendererMocks.renderScene.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Set x camera view' }))
    expect(rendererMocks.renderScene.mock.calls.length).toBeGreaterThan(rendersBeforeCameraChange)

    fireEvent.click(screen.getByRole('button', { name: 'Toggle experiment' }))
    expect(onToggleSource).toHaveBeenCalledWith('experiment')
  })

  it('invalidates cached Geometry when only the resolved Material color changes', async () => {
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }
    const view = render(<JscadViewer layers={[coloredLayer]} lengthUnit="mm" {...callbacks} />)
    await waitFor(() => expect(rendererMocks.entitiesFromSolids).toHaveBeenCalledTimes(1))

    view.rerender(
      <JscadViewer
        layers={[
          {
            ...coloredLayer,
            parts: [
              {
                ...coloredLayer.parts[0],
                material: { name: 'Copper', variables: { color: '#d97706' } },
              },
            ],
          },
        ]}
        lengthUnit="mm"
        {...callbacks}
      />,
    )

    await waitFor(() => expect(rendererMocks.entitiesFromSolids).toHaveBeenCalledTimes(2))
    expect(rendererMocks.entitiesFromSolids.mock.calls[1][0]).toMatchObject({
      color: [217 / 255, 119 / 255, 6 / 255, 1],
    })
  })

  it('invalidates cached automatic color when only the canonical Material role changes', async () => {
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }
    const automaticLayer = {
      ...coloredLayer,
      parts: [
        {
          ...coloredLayer.parts[0],
          materialRole: 'wheel',
          material: { name: 'Colorless', variables: {} },
        },
      ],
    }
    const view = render(<JscadViewer layers={[automaticLayer]} lengthUnit="mm" {...callbacks} />)
    await waitFor(() => expect(rendererMocks.entitiesFromSolids).toHaveBeenCalledTimes(1))

    view.rerender(
      <JscadViewer
        layers={[
          {
            ...automaticLayer,
            parts: [{ ...automaticLayer.parts[0], materialRole: 'shell' }],
          },
        ]}
        lengthUnit="mm"
        {...callbacks}
      />,
    )

    await waitFor(() => expect(rendererMocks.entitiesFromSolids).toHaveBeenCalledTimes(2))
    expect((rendererMocks.entitiesFromSolids.mock.calls[0][0] as { color: unknown }).color).not.toEqual(
      (rendererMocks.entitiesFromSolids.mock.calls[1][0] as { color: unknown }).color,
    )
  })
})
