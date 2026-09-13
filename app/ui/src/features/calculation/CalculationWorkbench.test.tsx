import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CalculationWorkbench, type CalculationWorkbenchProps } from './CalculationWorkbench'
import { calculationAccessPolicy } from './calculationAccessPolicy'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as measurementQueries from '@/features/measurement/queryOptions'

const mocks = vi.hoisted(() => ({
  select: vi.fn(() => true),
  measurement: vi.fn(),
  measurementRows: [] as { id: number; experiment_id: number; recorded_at: string }[],
  invalidate: vi.fn(),
  refresh: vi.fn(),
  rows: [
    {
      id: 3,
      revision: 1,
      experiment_id: 2,
      name: 'First',
      source_code: 'export default function calculate(record) { return 1 }',
      contract_status: 'ready',
    },
    {
      id: 4,
      revision: 1,
      experiment_id: 2,
      name: 'Second',
      source_code: 'export default function calculate(record) { return 2 }',
      contract_status: 'ready',
    },
  ],
}))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'public' }))
vi.mock('@tanstack/react-query', async (original) => ({
  ...(await original<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: {
      items: queryKey.includes('calculations')
        ? mocks.rows
        : queryKey.includes('measurements')
          ? mocks.measurementRows
          : [],
    },
    isSuccess: true,
    isPending: false,
    isFetching: false,
    isLoading: false,
    isError: false,
  }),
}))
vi.mock('./useCalculationPreview', () => ({
  useCalculationPreview: () => ({
    preview: { status: 'success', output: { dtype: 'float64', shape: [], axes: [], data: 1 } },
    logs: [],
    invalidatePreview: mocks.invalidate,
    refreshPreview: mocks.refresh,
  }),
}))
vi.mock('./ResizableCalculationOutput', () => ({ ResizableCalculationOutput: () => <div>Return chart and logs</div> }))
vi.mock('./CalculationSourceEditor', () => ({
  CalculationSourceEditor: ({
    sourceCode,
    disabled,
    onSourceCodeChange,
  }: {
    sourceCode: string
    disabled: boolean
    onSourceCodeChange: (value: string) => void
  }) => (
    <textarea
      aria-label="Calculation code"
      value={sourceCode}
      disabled={disabled}
      onChange={(event) => onSourceCodeChange(event.target.value)}
    />
  ),
}))
vi.mock('@/features/measurement', () => ({
  MeasurementExplorer: ({ onSelect }: { onSelect: (row: unknown) => void }) => (
    <button onClick={() => onSelect({ id: 8, experiment_id: 2 })}>Choose Measurement 8</button>
  ),
}))

function Harness({
  readOnly = false,
  initialSelection = 3,
  overrides = {},
}: {
  readOnly?: boolean
  initialSelection?: number | null
  overrides?: Partial<CalculationWorkbenchProps>
}) {
  const [selectedId, setSelectedId] = useState<number | null>(initialSelection)
  const props: CalculationWorkbenchProps = {
    authenticated: !readOnly,
    dataReadable: true,
    busy: false,
    calculationDataBusy: false,
    columnRatios: [0.3, 0.4, 0.3],
    contextPending: false,
    persistable: !readOnly,
    sourceEditable: !readOnly,
    experimentId: 2,
    measurementId: 5,
    measurementLoading: false,
    measurementSelectionPending: false,
    menubar: null,
    onActivity: vi.fn(),
    onCalculationSelectionChange: (selection) => {
      if (!mocks.select()) return false
      setSelectedId(selection.calculationId)
      return true
    },
    onColumnRatiosChange: vi.fn(),
    onDeleteMeasurements: vi.fn(),
    onDirtyChange: vi.fn(),
    onOutputChartRatioChange: vi.fn(),
    onRequestLogin: vi.fn(),
    onSaveStateChange: vi.fn(),
    onUsageChanged: vi.fn(),
    publicDemoMutable: false,
    onSelectMeasurement: mocks.measurement,
    onClearMeasurement: vi.fn(),
    recordedData: null,
    recordedRules: [],
    ribbon: (controls) => <div aria-label="Calculation ribbon">{controls}</div>,
    saveCommand: 0,
    outputChartRatio: 0.65,
    selectedCalculationId: selectedId,
    viewer: <div>Viewer</div>,
    viewerExpanded: false,
  }
  return (
    <TooltipProvider>
      <CalculationWorkbench {...props} {...overrides} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.measurementRows = []
  mocks.select.mockReturnValue(true)
})

it('moves selection into popups and protects unsaved code when switching calculations', async () => {
  render(<Harness />)
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(
      'export default function calculate(record) { return 1 }',
    ),
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Calculation code' }), {
    target: { value: 'export default function calculate(record) { return 7 }' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  fireEvent.click(screen.getByRole('button', { name: 'First' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Second/ }))
  expect(confirm).toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(mocks.select).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Second/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(
    'export default function calculate(record) { return 2 }',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Measurement #5' }))
  fireEvent.click(screen.getByRole('button', { name: 'Choose Measurement 8' }))
  expect(mocks.measurement).toHaveBeenCalledWith({ id: 8, experiment_id: 2 })
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  confirm.mockRestore()
})

it('opens save and starts a new draft from the ribbon', async () => {
  render(<Harness />)
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(
      'export default function calculate(record) { return 1 }',
    ),
  )
  fireEvent.click(screen.getByRole('button', { name: '미리보기 갱신' }))
  expect(mocks.refresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '새 Calculation' }))
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).not.toHaveValue(
    'export default function calculate(record) { return 1 }',
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Calculation code' }), {
    target: { value: 'export default function calculate(record) { return 9 }' },
  })
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  expect(screen.getByRole('dialog', { name: '새 Calculation 저장' })).toBeInTheDocument()
})

it('keeps read-only selection available while disabling editing and deletion', async () => {
  render(<Harness readOnly />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'First' })).toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '새 Calculation' })).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'First' }))
  expect(screen.getByRole('button', { name: '선택한 Calculation 삭제' })).toBeDisabled()
})

it.each([
  ['Demo viewer', true, true, false, true, false],
  ['Demo admin', true, true, true, true, true],
  ['owner', true, false, true, true, true],
  ['unreadable private', false, false, false, false, false],
] as const)(
  'applies %s Calculation editing and persistence',
  async (_label, dataReadable, experimentIsDemo, experimentManageable, editable, persistable) => {
    const policy = calculationAccessPolicy({ dataReadable, experimentIsDemo, experimentManageable })
    expect(policy.persistable).toBe(persistable)
    render(<Harness overrides={{ ...policy, dataReadable }} />)
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(mocks.rows[0].source_code),
    )
    const editor = screen.getByRole('textbox', { name: 'Calculation code' })
    if (editable) {
      expect(editor).toBeEnabled()
      fireEvent.change(editor, { target: { value: 'export default function calculate(record) { return 9 }' } })
    } else {
      expect(editor).toBeDisabled()
    }
    const save = screen.getByRole('button', { name: /^저장/ })
    if (persistable) expect(save).not.toHaveAttribute('aria-disabled', 'true')
    else expect(save).toHaveAttribute('aria-disabled', 'true')
  },
)

it('waits for restoration, preserves restored selections, and does not default again after clearing', async () => {
  mocks.measurementRows = [{ id: 9, experiment_id: 2, recorded_at: '2026-01-01' }]
  const { rerender } = render(
    <Harness
      initialSelection={null}
      overrides={{
        contextPending: true,
        measurementSelectionPending: true,
        measurementId: null,
      }}
    />,
  )
  expect(mocks.measurement).not.toHaveBeenCalled()
  expect(mocks.select).not.toHaveBeenCalled()
  rerender(<Harness overrides={{ selectedCalculationId: 4, measurementId: 8 }} />)
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(mocks.rows[1].source_code),
  )
  expect(mocks.measurement).not.toHaveBeenCalled()
  expect(mocks.select).not.toHaveBeenCalled()
  rerender(<Harness overrides={{ selectedCalculationId: null, measurementId: null }} />)
  expect(mocks.measurement).not.toHaveBeenCalled()
  expect(mocks.select).not.toHaveBeenCalled()
})

it('selects available defaults only once after pending restoration finishes', async () => {
  const request = vi.spyOn(measurementQueries, 'measurementsQueryOptions')
  mocks.measurementRows = [{ id: 9, experiment_id: 2, recorded_at: '2026-01-01' }]
  const { rerender } = render(
    <Harness
      initialSelection={null}
      overrides={{
        contextPending: true,
        measurementSelectionPending: true,
        measurementId: null,
      }}
    />,
  )
  expect(mocks.measurement).not.toHaveBeenCalled()
  rerender(<Harness initialSelection={null} overrides={{ measurementId: null }} />)
  expect(request).toHaveBeenCalledWith(
    'public',
    2,
    expect.objectContaining({
      limit: 1,
      filter: { experiment_id: [2, 2] },
      null_filter: { recorded_at: 'is_not_null' },
      sort: ['updated_at', 'desc'],
    }),
  )
  await waitFor(() => expect(mocks.measurement).toHaveBeenCalledExactlyOnceWith(mocks.measurementRows[0]))
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(mocks.rows[0].source_code),
  )
  rerender(<Harness initialSelection={null} overrides={{ measurementId: null }} />)
  expect(mocks.measurement).toHaveBeenCalledOnce()
})
