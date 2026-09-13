import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { buildScalarHistogram } from './calculationHistogram'
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

it('shows actionable policy diagnostics and keeps runtime details in the log', () => {
  const { rerender } = render(
    <CalculationOutputChart
      preview={{
        status: 'error',
        code: 'policy',
        message: 'Random functions are not supported.',
        diagnostic: {
          message: 'Random functions are not supported.',
          range: { startLineNumber: 2, startColumn: 15, endLineNumber: 2, endColumn: 21 },
          sourceLine: '  return Math.random()',
        },
      }}
    />,
  )
  expect(screen.getByText('Line 2, Column 15')).toBeInTheDocument()
  expect(screen.getByText(/return Math.random/)).toBeInTheDocument()
  rerender(
    <CalculationOutputChart preview={{ status: 'error', code: 'runtime', message: 'sensitive runtime detail' }} />,
  )
  expect(screen.queryByText('sensitive runtime detail')).not.toBeInTheDocument()
  expect(screen.getByText('상세 오류는 우측 하단 로그에서 확인하세요.')).toBeInTheDocument()
})

it('includes an outlier in the histogram domain and handles constant and empty populations', () => {
  expect(buildScalarHistogram([0, 1, 2, 3], 10)).toMatchObject({
    markerRatio: 1,
    domainMin: 0,
    domainMax: 10,
  })
  const constant = buildScalarHistogram([5, 5, 5], 5)!
  expect(constant.bins).toHaveLength(1)
  expect(constant.bins[0].count).toBe(3)
  expect(constant.domainMin).toBeLessThan(5)
  expect(constant.domainMax).toBeGreaterThan(5)
  expect(buildScalarHistogram([], 1)).toBeNull()
})

it('identifies the current Measurement and explains unavailable comparison data', () => {
  const preview = { status: 'success', output: { dtype: 'float64', shape: [], axes: [], data: 10 } } as const
  const { rerender } = render(
    <CalculationOutputChart preview={preview} measurementId={42} scalarValues={[0, 1, 2, 3]} />,
  )
  expect(screen.getByText(/Measurement #42/)).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Calculation scalar output histogram' })).toBeInTheDocument()
  rerender(
    <CalculationOutputChart preview={preview} scalarValues={[]} comparisonMessage="수정한 Calculation을 저장하세요." />,
  )
  expect(screen.getByRole('img', { name: 'Calculation scalar output histogram' })).toBeInTheDocument()
  expect(screen.getByText('수정한 Calculation을 저장하세요.')).toBeInTheDocument()
})
