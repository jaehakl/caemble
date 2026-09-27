import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { CalculationWorkbench, type CalculationWorkbenchProps } from './CalculationWorkbench'
import { calculationAccessPolicy } from './calculationAccessPolicy'
import { TooltipProvider } from '@/components/ui/tooltip'
import * as measurementQueries from '@/features/measurement/queryOptions'
import { dbTables } from '@/api'

const mocks = vi.hoisted(() => ({
  select: vi.fn(() => true),
  measurement: vi.fn(),
  measurementRows: [] as { id: number; experiment_id: number; recorded_at: string }[],
  invalidate: vi.fn(),
  refresh: vi.fn(),
  fetching: false,
  failed: false,
  rows: [
    {
      id: 3,
      revision: 1,
      experiment_id: 2,
      name: 'First',
      source_code: 'export default function calculate(record) { return 1 }',
      contract_status: 'ready',
      calculation_data_count: 8,
      recorded_measurement_count: 10,
      measurement_count: 12,
    },
    {
      id: 4,
      revision: 1,
      experiment_id: 2,
      name: 'Second',
      source_code: 'export default function calculate(record) { return 2 }',
      contract_status: 'needs_preflight',
      calculation_data_count: 0,
      recorded_measurement_count: 10,
      measurement_count: 12,
    },
  ],
}))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'public' }))
vi.mock('./queryInvalidation', () => ({ invalidateCalculationMutation: vi.fn() }))
vi.mock('./CalculationLibraryDialog', () => ({
  CalculationLibraryDialog: ({
    onLoad,
    onClose,
    loadDisabled,
  }: {
    onLoad: (item: unknown) => boolean
    onClose: () => void
    loadDisabled: boolean
  }) => (
    <div role="dialog" aria-label="Import fixture">
      <button
        disabled={loadDisabled}
        onClick={() => {
          if (
            onLoad({
              name: 'Imported',
              description: 'Library description',
              source_code: 'export default function calculate(record) { return 42 }',
            })
          )
            onClose()
        }}
      >
        Import fixture
      </button>
    </div>
  ),
}))
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
    isFetching: queryKey.includes('calculations') && mocks.fetching,
    isLoading: false,
    isError: queryKey.includes('calculations') && mocks.failed,
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
    calculationDataBusy: false,
    columnRatios: [4 / 7, 3 / 7],
    contextPending: false,
    persistable: !readOnly,
    sourceEditable: !readOnly,
    experimentSolverNames: [],
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
    onDirtyChange: vi.fn(),
    onOutputChartRatioChange: vi.fn(),
    onRequestLogin: vi.fn(),
    onSaveStateChange: vi.fn(),
    onUsageChanged: vi.fn(),
    publicDemoMutable: false,
    onSelectMeasurement: mocks.measurement,
    recordedData: null,
    recordedRules: [],
    ribbon: (controls) => <div aria-label="Calculation ribbon">{controls}</div>,
    saveCommand: 0,
    outputChartRatio: 0.65,
    selectedCalculationId: selectedId,
  }
  return (
    <TooltipProvider>
      <CalculationWorkbench {...props} {...overrides} />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetching = false
  mocks.failed = false
  mocks.measurementRows = []
  mocks.select.mockReturnValue(true)
})

it('imports as an unsaved independent draft and saves with current preflight', async () => {
  const dirty = vi.fn()
  const upsert = vi.spyOn(dbTables.Calculation, 'upsertRow').mockResolvedValue([{ id: 20, revision: 1 }] as never)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Harness overrides={{ onDirtyChange: dirty }} />)
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(mocks.rows[0].source_code),
  )
  const ribbon = screen.getByLabelText('Calculation ribbon')
  expect(within(ribbon).getAllByRole('button')[0]).toHaveTextContent('불러오기')
  expect(within(ribbon).getAllByRole('button')[0]).toHaveClass('h-[72px]')
  fireEvent.change(screen.getByRole('textbox', { name: 'Calculation code' }), { target: { value: 'local edit' } })
  fireEvent.click(screen.getByRole('button', { name: '불러오기' }))
  fireEvent.click(screen.getByRole('button', { name: 'Import fixture' }))
  expect(confirm).toHaveBeenCalledOnce()
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue('local edit')
  expect(upsert).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('button', { name: 'Import fixture' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(
    'export default function calculate(record) { return 42 }',
  )
  expect(dirty).toHaveBeenLastCalledWith(true)
  expect(mocks.invalidate).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  const dialog = screen.getByRole('dialog', { name: '새 Calculation 저장' })
  expect(within(dialog).getByLabelText('이름')).toHaveValue('Imported')
  expect(within(dialog).getByLabelText('설명')).toHaveValue('Library description')
  fireEvent.click(within(dialog).getByRole('button', { name: '저장' }))
  await waitFor(() => expect(upsert).toHaveBeenCalledOnce())
  const payload = upsert.mock.calls[0][0][0]
  expect(payload).toMatchObject({
    experiment_id: 2,
    preflight_measurement_id: 5,
    output_layout: { shape: [] },
    experiment_record_ids: [],
  })
  expect(payload).not.toHaveProperty('id')
  expect(payload).not.toHaveProperty('base_revision')
  expect(mocks.rows[0].source_code).toBe('export default function calculate(record) { return 1 }')
  confirm.mockRestore()
  upsert.mockRestore()
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
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Second.*Calculation #4/ }))
  expect(confirm).toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(mocks.select).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Second.*Calculation #4/ }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toHaveValue(
    'export default function calculate(record) { return 2 }',
  )
  confirm.mockRestore()
})

it('closes the library when the target Experiment changes', async () => {
  const view = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '불러오기' }))
  expect(screen.getByRole('dialog', { name: 'Import fixture' })).toBeInTheDocument()
  view.rerender(<Harness overrides={{ experimentId: 9 }} />)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Import fixture' })).not.toBeInTheDocument())
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
  await waitFor(() => expect(screen.getByRole('button', { name: 'Calculations' })).toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Calculation code' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '새 Calculation' })).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
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

it('shows a large Calculations button and per-row status with both Measurement totals', async () => {
  render(<Harness />)
  const button = screen.getByRole('button', { name: 'Calculations' })
  expect(button).toHaveClass('h-[72px]')
  expect(screen.queryByRole('button', { name: /Measurement|ExperimentRecord/ })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('3D Viewer')).not.toBeInTheDocument()
  expect(screen.queryByText('Return 차트')).not.toBeInTheDocument()
  fireEvent.click(button)
  expect(screen.getByText('준비됨 · 저장 8 / 기록 완료 10 · 전체 12 Measurements')).toBeInTheDocument()
  expect(screen.getByText('사전 검증 필요 · 저장 0 / 기록 완료 10 · 전체 12 Measurements')).toBeInTheDocument()
})

it('does not present stale counts as current while refreshing or after a failed refresh', () => {
  const { rerender } = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  mocks.fetching = true
  rerender(<Harness />)
  expect(screen.getAllByText(/저장 현황 조회 중/)).toHaveLength(2)
  expect(screen.queryByText(/저장 8/)).not.toBeInTheDocument()
  mocks.fetching = false
  mocks.failed = true
  rerender(<Harness />)
  expect(screen.getByText('Calculation 목록을 불러오지 못했습니다.')).toBeInTheDocument()
  expect(screen.queryByText(/저장 8/)).not.toBeInTheDocument()
})

it('deletes an unselected row without changing the active draft and prevents duplicate requests', async () => {
  let finish!: () => void
  const remove = vi.spyOn(dbTables.Calculation, 'deleteRows').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(undefined as never)
      }),
  )
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const usage = vi.fn().mockResolvedValue(undefined)
  const dirty = vi.fn()
  render(<Harness overrides={{ onUsageChanged: usage, onDirtyChange: dirty }} />)
  const editor = screen.getByRole('textbox', { name: 'Calculation code' })
  fireEvent.change(editor, { target: { value: 'local edit' } })
  mocks.select.mockClear()
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  const button = screen.getByRole('button', { name: 'Second 삭제' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(remove).toHaveBeenCalledExactlyOnceWith([4])
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Second'))
  expect(confirm).not.toHaveBeenCalledWith(expect.stringContaining('저장하지 않은 편집'))
  expect(button).toBeDisabled()
  expect(within(button).getByLabelText('삭제 중')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'First 삭제' })).toBeDisabled()
  await act(async () => finish())
  expect(usage).toHaveBeenCalledOnce()
  expect(mocks.select).not.toHaveBeenCalled()
  expect(editor).toHaveValue('local edit')
  expect(dirty).toHaveBeenLastCalledWith(true)
  expect(screen.getByRole('dialog', { name: 'Calculations' })).toBeInTheDocument()
  expect(button).not.toBeDisabled()
})

it('clears the current draft after deleting its row and keeps the picker open', async () => {
  const remove = vi.spyOn(dbTables.Calculation, 'deleteRows').mockResolvedValue(undefined as never)
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  render(<Harness overrides={{ onUsageChanged: vi.fn().mockResolvedValue(undefined) }} />)
  const editor = screen.getByRole('textbox', { name: 'Calculation code' })
  fireEvent.change(editor, { target: { value: 'local edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  fireEvent.click(screen.getByRole('button', { name: 'First 삭제' }))
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith([3]))
  await waitFor(() => expect(editor).not.toHaveValue('local edit'))
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining('저장하지 않은 편집'))
  expect(screen.getByRole('dialog', { name: 'Calculations' })).toBeInTheDocument()
})

it('preserves editing when deletion is cancelled or fails', async () => {
  const remove = vi.spyOn(dbTables.Calculation, 'deleteRows').mockRejectedValue(new Error('delete failed'))
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const usage = vi.fn().mockResolvedValue(undefined)
  render(<Harness overrides={{ onUsageChanged: usage }} />)
  const editor = screen.getByRole('textbox', { name: 'Calculation code' })
  fireEvent.change(editor, { target: { value: 'local edit' } })
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  const button = screen.getByRole('button', { name: 'First 삭제' })
  fireEvent.click(button)
  expect(remove).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  fireEvent.click(button)
  await waitFor(() => expect(button).not.toBeDisabled())
  expect(remove).toHaveBeenCalledExactlyOnceWith([3])
  expect(editor).toHaveValue('local edit')
  expect(usage).not.toHaveBeenCalled()
})

it('disables row deletion without permission, during data operations, and during context changes', () => {
  const { rerender } = render(<Harness readOnly />)
  fireEvent.click(screen.getByRole('button', { name: 'Calculations' }))
  expect(screen.getByRole('button', { name: 'First 삭제' })).toBeDisabled()
  rerender(<Harness overrides={{ calculationDataBusy: true }} />)
  expect(screen.getByRole('button', { name: 'First 삭제' })).toBeDisabled()
  rerender(<Harness overrides={{ contextPending: true }} />)
  expect(screen.getByRole('button', { name: 'First 삭제' })).toBeDisabled()
})
