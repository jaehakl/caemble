import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { CalculationOutputChart } from './CalculationOutputChart'

vi.mock('@/features/viewer/viewer/RecordedDataResults', () => ({ LineChart: () => <div>Line chart</div> }))
vi.mock('@/features/viewer/viewer/Heatmap', () => ({ Heatmap: () => <div>Heatmap</div> }))
vi.mock('@/features/viewer/viewer/PointCloudPlot', () => ({ PointCloudPlot: () => <div>Point cloud</div> }))
vi.mock('@/features/viewer/viewer/boxGridViewData', () => ({ scalarPlotData: (value: unknown) => value }))

it('renders scalar output as a chart even without saved comparison data', () => {
  const { container } = render(
    <CalculationOutputChart
      preview={{ status: 'success', output: { dtype: 'float64', shape: [], axes: [], data: 5 } }}
    />,
  )
  expect(screen.getByRole('img', { name: 'Calculation scalar output histogram' })).toBeInTheDocument()
  expect(container.querySelector('[aria-label="Calculation scalar output"]')).toBeNull()
})

it('preserves line, heatmap and 3D output rendering and handles empty tensors', () => {
  const axis = { name: 'x', ticks: [0] }
  const { rerender } = render(
    <CalculationOutputChart
      preview={{ status: 'success', output: { dtype: 'float64', shape: [1], axes: [axis], data: [1] } }}
    />,
  )
  expect(screen.getByText('Line chart')).toBeInTheDocument()
  rerender(
    <CalculationOutputChart
      preview={{ status: 'success', output: { dtype: 'float64', shape: [1, 1], axes: [axis, axis], data: [1] } }}
    />,
  )
  expect(screen.getByText('Heatmap')).toBeInTheDocument()
  rerender(
    <CalculationOutputChart
      preview={{
        status: 'success',
        output: { dtype: 'float64', shape: [1, 1, 1], axes: [axis, axis, axis], data: [1] },
      }}
    />,
  )
  expect(screen.getByText('Point cloud')).toBeInTheDocument()
  rerender(
    <CalculationOutputChart
      preview={{
        status: 'success',
        output: { dtype: 'float64', shape: [0], axes: [{ name: 'x', ticks: [] }], data: [] },
      }}
    />,
  )
  expect(screen.getByText(/Empty Output/)).toBeInTheDocument()
})
