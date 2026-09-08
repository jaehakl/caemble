import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CalculationDataOutput } from '@/api'
import { PredictionCalculationPane, type PredictionCalculationPaneItem } from './PredictionPanels'
import { comparePredictionOutput } from './metrics'

vi.mock('@/components/tensor-editor', () => ({
  TensorEditor: (props: Record<string, unknown>) => <pre data-testid="tensor">{JSON.stringify(props)}</pre>,
}))

const reference: CalculationDataOutput = {
  dtype: 'float64',
  shape: [2],
  axes: [{ name: 'time', unit: 's', ticks: [0, 1] }],
  data: [10, 20],
}

function renderPane(actual: CalculationDataOutput, repredicted?: CalculationDataOutput) {
  const item: PredictionCalculationPaneItem = {
    calculationId: 1,
    name: 'Result',
    minimum: 0,
    maximum: 20,
    constraintMinimum: -100,
    constraintMaximum: 100,
    primary: { output: reference, role: repredicted ? 'target' : 'predicted', status: 'ready' },
    actual: { output: actual, status: 'ready', metric: comparePredictionOutput(reference, actual) },
    ...(repredicted
      ? {
          repredicted: {
            output: repredicted,
            status: 'ready' as const,
            metric: comparePredictionOutput(reference, repredicted),
          },
        }
      : {}),
  }
  render(
    <PredictionCalculationPane
      disabled={false}
      items={[item]}
      mode="prediction"
      resetKey="test"
      status="Ready"
      updating={false}
      onOutputChange={vi.fn()}
    />,
  )
}

describe('Prediction calculation result display', () => {
  it.each([
    ['ticks', { ...reference, axes: [{ name: 'time', unit: 's', ticks: [0, 2] }] }],
    ['name', { ...reference, axes: [{ name: 'distance', unit: 's', ticks: [0, 1] }] }],
    ['unit', { ...reference, axes: [{ name: 'time', unit: 'ms', ticks: [0, 1] }] }],
    ['dtype', { ...reference, dtype: 'float32' }],
  ] as const)('overlays Actual by index when %s differs', (_field, layout) => {
    const actual = { ...layout, data: [12, 22] }
    renderPane(actual)
    expect(screen.queryByRole('region', { name: 'Save + Run Actual' })).not.toBeInTheDocument()
    const primary = JSON.parse(screen.getByTestId('tensor').textContent!)
    expect(primary.axes).toEqual(reference.axes)
    expect(primary.comparison.series[0].value).toEqual([12, 22])
    expect(screen.getByText(/Predicted ↔ Actual.*MAE 2/)).toBeInTheDocument()
    expect(actual.axes).toEqual(layout.axes)
  })

  it('shows Actual separately when shape differs', () => {
    const actual: CalculationDataOutput = {
      ...reference,
      shape: [1],
      axes: [{ name: 'time', unit: 's', ticks: [0] }],
      data: [30],
    }
    renderPane(actual)
    const separate = screen.getByRole('region', { name: 'Save + Run Actual' })
    const props = JSON.parse(within(separate).getByTestId('tensor').textContent!)
    expect(props.axes).toEqual(actual.axes)
    expect(props.shape).toEqual(actual.shape)
    expect(props.value).toEqual(actual.data)
    expect(props.disabled).toBe(true)
    const primary = JSON.parse(screen.getAllByTestId('tensor')[0].textContent!)
    expect(primary.comparison.series).toEqual([])
    expect(screen.getByText(/Predicted ↔ Actual.*shape/)).toBeInTheDocument()
    expect(comparePredictionOutput(reference, actual).mae).toBeNull()
  })

  it('keeps compatible Actual in the primary comparison', () => {
    renderPane({ ...reference, data: [12, 22] })
    expect(screen.queryByRole('region', { name: 'Save + Run Actual' })).not.toBeInTheDocument()
    const primary = JSON.parse(screen.getByTestId('tensor').textContent!)
    expect(primary.comparison.series[0].value).toEqual([12, 22])
    expect(screen.getByText(/Predicted ↔ Actual.*MAE 2/)).toBeInTheDocument()
  })

  it('overlays all inverse results and calculates each pair despite different coordinates', () => {
    const axes = [{ name: 'time', unit: 's', ticks: [0, 2] }]
    renderPane({ ...reference, axes, data: [12, 22] }, { ...reference, axes, data: [11, 21] })
    expect(screen.queryByRole('region', { name: 'Save + Run Actual' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Re-predicted' })).not.toBeInTheDocument()
    const primary = JSON.parse(screen.getByTestId('tensor').textContent!)
    expect(primary.comparison.series.map((series: { value: number[] }) => series.value)).toEqual([
      [11, 21],
      [12, 22],
    ])
    expect(screen.getByText(/Re-predicted ↔ Actual.*MAE 1/)).toBeInTheDocument()
    expect(screen.getByText(/Target ↔ Re-predicted.*MAE 1/)).toBeInTheDocument()
    expect(screen.getByText(/Target ↔ Actual.*MAE 2/)).toBeInTheDocument()
  })
})
