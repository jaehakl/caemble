// @vitest-environment jsdom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JscadViewer from './JscadViewer'

const rendererMocks = vi.hoisted(() => {
  const render = vi.fn()
  return {
    entitiesFromSolids: vi.fn((_options: unknown, geometry: unknown) => [{ geometry }]),
    prepareRender: vi.fn(() => render),
    render,
  }
})
let resizeObserverCallbacks: ResizeObserverCallback[] = []

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

class FakeWorker {
  static instances: FakeWorker[] = []
  static constructorError: Error | null = null
  static postMessageError: Error | null = null

  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  request: { requestId: string } | null = null
  terminated = false

  constructor() {
    if (FakeWorker.constructorError) throw FakeWorker.constructorError
    FakeWorker.instances.push(this)
  }

  postMessage(request: { requestId: string }) {
    if (FakeWorker.postMessageError) throw FakeWorker.postMessageError
    this.request = request
  }

  terminate() {
    this.terminated = true
  }

  succeed() {
    this.onmessage?.({
      data: {
        requestId: this.request?.requestId,
        result: {
          candidatePointCount: 1,
          colors: new Float32Array([0.1, 0.2, 0.3, 1]),
          effectiveSpacing: 1,
          positions: new Float32Array([0, 0, 0]),
          requestedSpacing: 1,
          visiblePointCount: 1,
        },
        type: 'success',
      },
    } as MessageEvent)
  }

  fail(message: string) {
    this.onerror?.({ message } as ErrorEvent)
  }

  messageError() {
    this.onmessageerror?.({} as MessageEvent)
  }
}

const coloredLayer = {
  documentType: 'structure' as const,
  lengthUnit: 'mm' as const,
  parts: [
    {
      id: 'part',
      geometry: {},
      material: { name: 'Copper', variables: { color: '#a1b2c3' } },
      surfaces: [],
    },
  ],
  sceneHash: 'same-scene',
}
const coloredLayers = [coloredLayer]
const recordedDataRules = [
  {
    target: ['experiment.geometry.domain'] as const,
    label: 'Domain average',
    methodId: 'field.average',
    parameters: {},
    result: {
      dtype: 'float64' as const,
      unit: '{fraction}',
      quantityKind: 'DimensionlessRatio' as const,
    },
  },
]

function GridHarness() {
  const [status, setStatus] = useState('Ready')
  return (
    <>
      <output aria-label="Render status">{status}</output>
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        onRenderEnd={() => setStatus('Ready')}
        onRenderError={() => setStatus('Error')}
        onRenderStart={() => setStatus('Rendering')}
      />
    </>
  )
}

describe('JscadViewer render lifecycle', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    FakeWorker.constructorError = null
    FakeWorker.postMessageError = null
    resizeObserverCallbacks = []
    rendererMocks.entitiesFromSolids.mockClear()
    rendererMocks.prepareRender.mockClear()
    rendererMocks.render.mockClear()
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeObserverCallbacks.push(callback)
        }
        observe() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps one grid worker alive across Rendering status rerenders and returns to Ready after drawing points', async () => {
    render(<GridHarness />)

    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))

    await waitFor(() => expect(screen.getByLabelText('Render status')).toHaveTextContent('Rendering'))
    expect(FakeWorker.instances).toHaveLength(1)
    expect(FakeWorker.instances[0].terminated).toBe(false)

    act(() => FakeWorker.instances[0].succeed())

    await waitFor(() => expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready'))
    expect(screen.getByText(/1 points/)).toBeInTheDocument()
    expect(FakeWorker.instances).toHaveLength(1)
  })

  it('ends Rendering when the grid worker cannot be constructed', async () => {
    FakeWorker.constructorError = new Error('Worker unavailable')
    render(<GridHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Worker unavailable'))
    expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready')
  })

  it('ends Rendering when the grid request cannot be posted', async () => {
    FakeWorker.postMessageError = new Error('Clone failed')
    render(<GridHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Clone failed'))
    expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready')
    expect(FakeWorker.instances[FakeWorker.instances.length - 1]?.terminated).toBe(true)
  })

  it('ends Rendering when the grid worker reports an asynchronous error', async () => {
    render(<GridHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))

    act(() => FakeWorker.instances[0].fail('Grid calculation failed'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Grid calculation failed'))
    expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready')
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('ends Rendering when the grid worker cannot deserialize its response', async () => {
    render(<GridHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))

    act(() => FakeWorker.instances[0].messageError())

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('could not deserialize'))
    expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready')
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('ends Rendering and terminates a grid worker after 30 seconds', () => {
    vi.useFakeTimers()
    render(<GridHarness />)
    fireEvent.click(screen.getByRole('tab', { name: 'Material Grid' }))

    expect(screen.getByLabelText('Render status')).toHaveTextContent('Rendering')
    expect(FakeWorker.instances).toHaveLength(1)

    act(() => vi.advanceTimersByTime(30_000))

    expect(screen.getByRole('alert')).toHaveTextContent('timed out after 30 seconds')
    expect(screen.getByLabelText('Render status')).toHaveTextContent('Ready')
    expect(FakeWorker.instances[0].terminated).toBe(true)
  })

  it('invalidates geometry entities when only the resolved Material color changes', async () => {
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

  it('shows 3D and Results together in a wide split layout and supports accessible resizing', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 100,
      right: 1000,
      top: 0,
      width: 900,
      x: 100,
      y: 0,
      toJSON: () => undefined,
    })
    const callbacks = {
      onRenderEnd: vi.fn(),
      onRenderError: vi.fn(),
      onRenderStart: vi.fn(),
    }
    const view = render(
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        recordedData={{ 'Domain average': { value: 0.5 } }}
        recordedDataRules={recordedDataRules}
        resultsLayout="split"
        {...callbacks}
      />,
    )

    const separator = await screen.findByRole('separator', { name: '3D Viewer와 Results 크기 조절' })
    const canvas = view.container.querySelector('[data-viewer-canvas="true"]')
    expect(canvas).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Results' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Recorded Data Results')).toBeVisible()
    expect(screen.getByLabelText('Recorded scalar value')).toHaveTextContent('0.5')
    expect(separator).toHaveAttribute('aria-valuenow', '50')

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator).toHaveAttribute('aria-valuenow', '52')

    Object.assign(separator, {
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    })
    fireEvent.pointerDown(separator, { pointerId: 1 })
    const moveRight = new Event('pointermove', { bubbles: true })
    Object.defineProperties(moveRight, {
      clientX: { value: 640 },
      pointerId: { value: 1 },
    })
    fireEvent(separator, moveRight)
    expect(separator).toHaveAttribute('aria-valuenow', '60')
    const moveLeft = new Event('pointermove', { bubbles: true })
    Object.defineProperties(moveLeft, {
      clientX: { value: 100 },
      pointerId: { value: 1 },
    })
    fireEvent(separator, moveLeft)
    expect(separator).toHaveAttribute('aria-valuenow', '36')

    fireEvent.doubleClick(separator)
    expect(separator).toHaveAttribute('aria-valuenow', '50')

    view.rerender(
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        recordedData={{ 'Domain average': { value: 0.75 } }}
        recordedDataRules={recordedDataRules}
        resultsLayout="split"
        {...callbacks}
      />,
    )
    expect(view.container.querySelector('[data-viewer-canvas="true"]')).toBe(canvas)
    expect(screen.getByLabelText('Recorded scalar value')).toHaveTextContent('0.75')
  })

  it('keeps the initialized Canvas when the first width measurement enables the split layout', async () => {
    let viewerWidth = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 500,
      height: 500,
      left: 0,
      right: viewerWidth,
      top: 0,
      width: viewerWidth,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    }))
    const view = render(
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        recordedData={{ 'Domain average': { value: 0.5 } }}
        recordedDataRules={recordedDataRules}
        resultsLayout="split"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )
    const canvas = view.container.querySelector('[data-viewer-canvas="true"]')
    expect(canvas).toBeVisible()
    expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(1)

    viewerWidth = 900
    act(() => {
      resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    await screen.findByRole('separator', { name: '3D Viewer와 Results 크기 조절' })
    expect(view.container.querySelector('[data-viewer-canvas="true"]')).toBe(canvas)
    expect(canvas).toBeVisible()
    expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(1)
    expect(rendererMocks.render).toHaveBeenCalled()
  })

  it('uses Results tabs while narrow and returns to Geometry when the container becomes wide', async () => {
    let viewerWidth = 600
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: 500,
      height: 500,
      left: 0,
      right: viewerWidth,
      top: 0,
      width: viewerWidth,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    }))
    const view = render(
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        recordedData={{ 'Domain average': { value: 0.5 } }}
        recordedDataRules={recordedDataRules}
        resultsLayout="split"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    const resultsTab = await screen.findByRole('tab', { name: 'Results' })
    const canvas = view.container.querySelector('[data-viewer-canvas="true"]')
    expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(resultsTab)
    expect(resultsTab).toHaveAttribute('aria-selected', 'true')

    viewerWidth = 900
    act(() => {
      resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    const separator = await screen.findByRole('separator', { name: '3D Viewer와 Results 크기 조절' })
    expect(separator).toBeVisible()
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Geometry' })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.queryByRole('tab', { name: 'Results' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Recorded Data Results')).toBeVisible()
    expect(view.container.querySelector('[data-viewer-canvas="true"]')).toBe(canvas)
    expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(1)

    viewerWidth = 600
    act(() => {
      resizeObserverCallbacks.forEach((callback) => callback([], {} as ResizeObserver))
    })

    expect(await screen.findByRole('tab', { name: 'Results' })).toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-viewer-canvas="true"]')).toBe(canvas)
    expect(rendererMocks.prepareRender).toHaveBeenCalledTimes(1)
  })

  it('keeps the full-width 3D viewer when no recorded-data rules exist', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 900,
      top: 0,
      width: 900,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    })
    const view = render(
      <JscadViewer
        layers={coloredLayers}
        lengthUnit="mm"
        resultsLayout="split"
        onRenderEnd={() => undefined}
        onRenderError={() => undefined}
        onRenderStart={() => undefined}
      />,
    )

    await waitFor(() => expect(view.container.querySelector('[data-results-layout="tabs"]')).toBeInTheDocument())
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Results' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Recorded Data Results')).not.toBeInTheDocument()
  })
})
