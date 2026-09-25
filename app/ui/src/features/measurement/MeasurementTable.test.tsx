import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { MeasurementTable } from './MeasurementTable'
import { measurementQueryKeys } from './queryKeys'

const mocks = vi.hoisted(() => ({ listRows: vi.fn() }))
vi.mock('@/features/auth/use-auth', () => ({ usePrivateQueryScope: () => 'public' }))
vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, dbTables: { ...actual.dbTables, Measurement: { listRows: mocks.listRows } } }
})

const defaults = {
  experimentId: 7,
  active: true,
  dataReadable: true,
  selectedId: 21,
  loading: false,
  onSelect: vi.fn(),
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.listRows.mockResolvedValue({
    items: [
      { id: 21, recorded_at: '2026-09-26' },
      { id: 20, recorded_at: null },
    ],
    total: 21,
  })
})

function setup(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<MeasurementTable {...defaults} {...props} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  return { ...view, client }
}

it('queries only when open and readable, and displays ID, status and the committed selection', async () => {
  const { rerender } = setup({ active: false })
  expect(mocks.listRows).not.toHaveBeenCalled()
  rerender(<MeasurementTable {...defaults} />)
  const recorded = await screen.findByRole('button', { name: 'Measurement #21 Recorded' })
  expect(recorded).toHaveAttribute('aria-current', 'true')
  expect(mocks.listRows).toHaveBeenCalledWith(
    expect.objectContaining({
      filter: { experiment_id: [7, 7] },
      sort: [
        ['created_at', 'desc'],
        ['id', 'desc'],
      ],
      offset: 0,
      limit: 20,
    }),
    expect.objectContaining({ resolveObjects: false }),
  )
  fireEvent.click(recorded)
  fireEvent.click(screen.getByText('Prepared'))
  expect(defaults.onSelect.mock.calls).toEqual([[21], [20]])
})

it('paginates, resets for another Experiment and responds to existing list invalidation', async () => {
  const { rerender, client } = setup()
  await screen.findByRole('button', { name: 'Measurement #21 Recorded' })
  fireEvent.click(screen.getByRole('button', { name: '다음' }))
  await waitFor(() =>
    expect(mocks.listRows).toHaveBeenCalledWith(expect.objectContaining({ offset: 20 }), expect.anything()),
  )
  rerender(<MeasurementTable {...defaults} experimentId={8} />)
  await waitFor(() =>
    expect(mocks.listRows).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { experiment_id: [8, 8] }, offset: 0 }),
      expect.anything(),
    ),
  )
  await screen.findByText('1 / 2')
  const calls = mocks.listRows.mock.calls.length
  await client.invalidateQueries({ queryKey: measurementQueryKeys.lists('public', 8) })
  expect(mocks.listRows.mock.calls.length).toBe(calls + 1)
})

it('shows save and login guidance without querying inaccessible data', () => {
  const { rerender } = setup({ experimentId: null })
  expect(screen.getByText('먼저 저장된 Experiment를 불러오세요.')).toBeVisible()
  rerender(<MeasurementTable {...defaults} dataReadable={false} />)
  expect(screen.getByText('Measurement를 보려면 로그인하세요.')).toBeVisible()
  expect(mocks.listRows).not.toHaveBeenCalled()
})

it('offers retry on failure and shows an empty list after a successful retry', async () => {
  mocks.listRows.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [], total: 0 })
  setup()
  expect(await screen.findByRole('alert')).toHaveTextContent('목록을 불러오지 못했습니다.')
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }))
  expect(await screen.findByText('Measurement가 없습니다.')).toBeVisible()
})
