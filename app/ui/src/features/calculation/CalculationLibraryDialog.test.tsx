import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CalculationLibraryDetail } from '@/api/calculationLibrary'
import { calculationLibraryApi } from '@/api/calculationLibrary'
import { CalculationLibraryDialog } from './CalculationLibraryDialog'
import { calculationLibraryInputs, libraryInputShape } from './calculationLibraryPreview'

vi.mock('@/api/calculationLibrary', () => ({ calculationLibraryApi: { list: vi.fn(), detail: vi.fn() } }))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'test-owner' }))

const first: CalculationLibraryDetail = {
  source_id: 1,
  reference: { kind: 'saved', calculation_id: 1, coordinate: null, name: null },
  name: 'First calculation',
  description: '설명',
  experiment_name: 'Original',
  experiment_coordinate: 'tests/first@1.0.0',
  sources: ['mine'],
  solvers: [{ name: 'heat', version: '1.0.0' }],
  concepts: [],
  quantity_kinds: ['Temperature'],
  source_code:
    "export default function calculate(records) { return { dtype: 'float64', data: records.field.data[0] }; }",
  inputs: [
    {
      name: 'field',
      dtype: 'float64',
      tensor_order: 0,
      quantity_kind: 'Temperature',
      data_schema: { axes: [{ name: 'x', length: 4 }], unit: 'K' },
    },
  ],
  inputs_verified: true,
  output_layout: { dtype: 'float64', shape: [], axes: [] },
  preflight_measurement_id: 10,
  contract_status: 'ready',
}
const second = { ...first, reference: { ...first.reference, calculation_id: 2 }, name: 'Second calculation' }
const facets = { solvers: first.solvers, concepts: [], quantity_kinds: ['Temperature'] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(calculationLibraryApi.list).mockResolvedValue({ items: [first, second], total: 35, facets })
  vi.mocked(calculationLibraryApi.detail).mockImplementation(async (reference) =>
    reference.calculation_id === 1 ? first : second,
  )
})

function setup(authenticated = true) {
  const onLoad = vi.fn(() => true)
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <CalculationLibraryDialog authenticated={authenticated} loadDisabled={false} onClose={onClose} onLoad={onLoad} />
    </QueryClientProvider>,
  )
  return { onLoad, onClose }
}

it('only loads details on selection and imports on explicit action', async () => {
  const { onLoad, onClose } = setup()
  await screen.findByRole('button', { name: /First calculation/ })
  expect(calculationLibraryApi.detail).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '불러오기' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /First calculation/ }))
  expect(await screen.findByText(/원본 preflight Measurement #10 기준/)).toBeInTheDocument()
  expect(screen.getByText('shape: [4]')).toBeInTheDocument()
  expect(onLoad).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '불러오기' }))
  expect(onLoad).toHaveBeenCalledWith(first)
  expect(onClose).toHaveBeenCalledOnce()
})

it('resets page and selection on filters and prevents anonymous mine queries', async () => {
  setup(false)
  await screen.findByRole('button', { name: /First calculation/ })
  expect(screen.getByRole('option', { name: '내 항목' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '다음' }))
  await waitFor(() =>
    expect(calculationLibraryApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 30 }),
      expect.anything(),
    ),
  )
  fireEvent.change(screen.getByLabelText('Solver'), { target: { value: 'heat' } })
  await waitFor(() =>
    expect(calculationLibraryApi.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, solver_name: 'heat', solver_version: '' }),
      expect.anything(),
    ),
  )
  expect(screen.getByRole('button', { name: '불러오기' })).toBeDisabled()
})

it('ignores a late response for a previously selected item', async () => {
  let finishFirst!: (value: CalculationLibraryDetail) => void
  vi.mocked(calculationLibraryApi.detail).mockImplementation((reference) =>
    reference.calculation_id === 1
      ? new Promise((resolve) => {
          finishFirst = resolve
        })
      : Promise.resolve(second),
  )
  const { onLoad } = setup()
  fireEvent.click(await screen.findByRole('button', { name: /First calculation/ }))
  fireEvent.click(screen.getByRole('button', { name: /Second calculation/ }))
  await screen.findByRole('heading', { name: 'Second calculation' })
  await act(async () => finishFirst(first))
  expect(
    within(screen.getByRole('region', { name: 'Calculation 상세' })).queryByRole('heading', {
      name: 'First calculation',
    }),
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '불러오기' }))
  expect(onLoad).toHaveBeenCalledWith(second)
})

it('allows retrying a failed list and displays an empty search', async () => {
  vi.mocked(calculationLibraryApi.list)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ items: [], total: 0, facets })
  setup()
  fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }))
  expect(await screen.findByText('검색 결과가 없습니다.')).toBeInTheDocument()
})

it('distinguishes scalar, multi-axis and unknown contracts without executing code', () => {
  expect(libraryInputShape({ axes: [] })).toBe('[]')
  expect(libraryInputShape({ axes: [{ ticks: [0, 1] }, { length: 3 }, { name: 'dynamic' }] })).toBe('[2, 3, ?]')
  expect(libraryInputShape(null)).toBe('동적·미확인')
  const unknown = calculationLibraryInputs({ ...first, inputs: [], inputs_verified: false })
  expect(unknown.items).toEqual([{ name: 'field', contract: null }])
  expect(calculationLibraryInputs({ ...first, source_code: 'broken(' }).error).not.toBeNull()
})
