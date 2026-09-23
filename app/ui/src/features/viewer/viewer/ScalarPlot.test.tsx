import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ScalarPlotData } from './boxGridViewData'
import { heatmapLayout, ScalarPlot } from './ScalarPlot'

const plot: ScalarPlotData = {
  axes: [
    { name: 'y', ticks: [0, 10], unit: 'm' },
    { name: 'x', ticks: [0, 2, 6], unit: 'm' },
  ],
  shape: [2, 3],
  values: [1, 2, 3, 4, 5, 6],
  range: [1, 6],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('fits square cells by row and column count while preserving physical gaps in fill mode', () => {
  const edges = [
    [-5, 5, 15],
    [-1, 1, 4, 8],
  ]
  const square = heatmapLayout(500, 300, edges, true)
  expect(square.w / square.h).toBeCloseTo(3 / 2)
  expect(square.w / 3).toBeCloseTo(square.h / 2)
  expect(square.left).toBeCloseTo(117.5)
  expect(square.normalized[1]).toEqual([0, 1 / 3, 2 / 3, 1])

  const filled = heatmapLayout(500, 300, edges, false)
  expect([filled.left, filled.top, filled.w, filled.h]).toEqual([75, 25, 400, 210])
  expect(filled.normalized[1][1]).toBeCloseTo(2 / 9)
  expect(filled.normalized[1][2]).toBeCloseTo(5 / 9)
})

it('removes chart size buttons and aligns nonuniform axis labels and hover cells with the chosen mode', () => {
  const context = {
    scale: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    putImageData: vi.fn(),
    fillRect: vi.fn(),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(_data: Uint8ClampedArray, _width: number, _height: number) {}
    },
  )

  const { rerender } = render(<ScalarPlot plot={plot} kind="heatmap" squarePixels />)
  expect(screen.queryByRole('button', { name: '화면 맞춤' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '원본 크기' })).not.toBeInTheDocument()
  expect(context.drawImage).toHaveBeenCalled()
  expect(context.fillText.mock.calls.some(([label]) => label === '0.5')).toBe(true)
  fireEvent.mouseMove(screen.getByRole('img', { name: 'heatmap 차트' }), { clientX: 208, clientY: 120 })
  expect(screen.getByRole('status')).toHaveTextContent('x=2')

  context.fillText.mockClear()
  rerender(<ScalarPlot plot={plot} kind="heatmap" squarePixels={false} />)
  expect(context.fillRect).toHaveBeenCalled()
  expect(context.fillText.mock.calls.some(([label]) => label === '1.25')).toBe(true)
  fireEvent.mouseMove(screen.getByRole('img', { name: 'heatmap 차트' }), { clientX: 208, clientY: 120 })
  expect(screen.getByRole('status')).toHaveTextContent('x=6')
})
