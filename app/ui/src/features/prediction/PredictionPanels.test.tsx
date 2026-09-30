import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CalculationDataOutput } from '@/api'
import { VarsPanel } from '../calculation/VarsPanel'
import {
  PredictionVarsPane,
  PredictionCalculationPane,
  PredictionDetailsDialog,
  PredictionSetupDialog,
  type PredictionCalculationPaneItem,
} from './PredictionPanels'
import type { PredictionModelProfile } from './execution'
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

it('uses the shared Vars bars and removes Experiment and Sampling controls', () => {
  const schema = { width: { min: 0, max: 10, shape: [] } }
  const onVariableChange = vi.fn()
  const { rerender } = render(
    <VarsPanel
      candidateSessionKey="candidate"
      disabled={false}
      schema={schema}
      vars={{ width: 2 }}
      onVariableChange={onVariableChange}
    />,
  )
  expect(screen.getByRole('button', { name: /width/ })).toHaveAttribute('aria-expanded', 'false')
  const props = {
    candidateSessionKey: 'candidate',
    direction: 'forward' as const,
    disabled: false,
    guideVisible: false,
    schema,
    status: 'Ready',
    updating: false,
    onDismissGuide: vi.fn(),
    onVarsChange: vi.fn(),
  }
  rerender(<PredictionVarsPane {...props} vars={null} />)
  expect(screen.getByText('Vars를 준비하는 중입니다.')).toBeInTheDocument()
  rerender(<PredictionVarsPane {...props} vars={{ width: 2 }} />)
  expect(screen.queryByLabelText('Experiment')).not.toBeInTheDocument()
  expect(screen.queryByText(/Sampling/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument()
  const slider = screen.getByRole('slider', { name: 'width' })
  fireEvent.keyDown(slider, { key: 'End' })
  expect(props.onVarsChange).toHaveBeenLastCalledWith({ width: 10 })
  rerender(<PredictionVarsPane {...props} candidateSessionKey="next" vars={{ width: 3 }} />)
  expect(screen.getByRole('slider', { name: 'width' })).toHaveAttribute('aria-valuenow', '3')
})

it('renders common model details without requiring kNN or browser resource details', () => {
  const profile: PredictionModelProfile = {
    direction: 'forward',
    rowCount: 2,
    inputLayouts: [],
    inputSize: 1,
    outputSize: 1,
    includedMeasurementIds: [1, 2],
    warningMeasurementIds: [],
    diagnostics: [],
    omittedDiagnosticGroups: 0,
    excluded: {
      'missing-block': 0,
      'extra-block': 0,
      'invalid-tensor': 0,
      'fixed-layout-mismatch': 0,
      'layout-mismatch': 0,
    },
  }
  const props = {
    direction: 'forward' as const,
    neighbors: [],
    open: true,
    onDirectionChange: vi.fn(),
    onOpenChange: vi.fn(),
  }
  const { rerender } = render(<PredictionDetailsDialog {...props} profiles={{ forward: profile }} />)
  expect(screen.getByRole('region', { name: 'Prediction model profile' })).toBeInTheDocument()
  expect(screen.getByText('Cohort')).toBeInTheDocument()
  expect(screen.queryByText('Weighting')).not.toBeInTheDocument()
  expect(screen.queryByText('Scaling')).not.toBeInTheDocument()
  expect(screen.queryByText('Neighbors')).not.toBeInTheDocument()
  expect(screen.queryByText('Persistent memory')).not.toBeInTheDocument()
  expect(screen.queryByText(/Shape baseline/)).not.toBeInTheDocument()

  rerender(
    <PredictionDetailsDialog
      {...props}
      profiles={{
        forward: {
          ...profile,
          knn: {
            dominantShapeSignature: 'scalar',
            baselineMeasurementId: 1,
            k: 2,
            weighting: 'distance',
            inputScaling: 'range',
            inputScales: new Float64Array([1]),
            inputBlockWeights: {},
            activeInputBlockCount: 1,
          },
          resources: { persistentBytes: 64, workingSetBytes: 128 },
        },
      }}
    />,
  )
  expect(screen.getByText('Cohort / k')).toBeInTheDocument()
  expect(screen.getByText('Neighbors')).toBeInTheDocument()
  expect(screen.getByText('64 B')).toBeInTheDocument()
})

it('shows the supported algorithm and execution location as separate read-only settings', () => {
  render(
    <PredictionSetupDialog
      algorithmLabel="kNN"
      executionLabel="브라우저"
      calculationWeights={{}}
      calculations={[]}
      cohortSummaries={{}}
      kMode="auto"
      manualK={1}
      open
      selectedCalculationIds={[]}
      weighting="distance"
      onApply={vi.fn()}
      onCalculateMissing={vi.fn()}
      onCalculationSelectedChange={vi.fn()}
      onCalculationWeightChange={vi.fn()}
      onCancel={vi.fn()}
      onKModeChange={vi.fn()}
      onManualKChange={vi.fn()}
      onOpenChange={vi.fn()}
      onReload={vi.fn()}
      onWeightingChange={vi.fn()}
    />,
  )
  expect(screen.getByText('Algorithm').nextElementSibling).toHaveTextContent('kNN')
  expect(screen.getByText('Execution').nextElementSibling).toHaveTextContent('브라우저')
  expect(screen.queryByRole('combobox', { name: 'Algorithm' })).not.toBeInTheDocument()
  expect(screen.queryByText('Deep Learning')).not.toBeInTheDocument()
})
