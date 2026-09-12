import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import type { UserData } from '@/api'
import { ExperimentShowcase } from './ExperimentShowcase'

const mocks = vi.hoisted(() => ({ available: vi.fn(), usage: vi.fn(), deleteRows: vi.fn() }))
vi.mock('@/api', () => ({ dbTables: { Experiment: mocks } }))

const old = {
  id: 1,
  user_id: 'owner',
  name: 'Previous',
  namespace: 'owner',
  repository_slug: 'repo',
  experiment_key: 'same',
  version_major: 1,
  version_minor: 0,
  version_patch: 0,
  created_at: '2026-01-01',
}
const latest = { ...old, id: 2, name: 'Latest', version_minor: 1, created_at: '2026-02-01' }
const demo = { ...old, id: 3, experiment_key: 'demo', name: 'Demo', isDemo: true }

function mount(user: UserData | null = null, selectedId: number | null = null) {
  const onSelect = vi.fn(),
    onEdit = vi.fn(),
    onDeleteSelected = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ExperimentShowcase
        user={user}
        selectedId={selectedId}
        onSelect={onSelect}
        onEdit={onEdit}
        onDeleteSelected={onDeleteSelected}
      />
    </QueryClientProvider>,
  )
  return { onSelect, onEdit, onDeleteSelected }
}
beforeEach(() => {
  vi.restoreAllMocks()
  mocks.available.mockResolvedValue({ mine: [old, latest], demos: [demo] })
  mocks.usage.mockResolvedValue({ items: [{ derivedCounts: { measurements: 2, recordedData: 1, calculations: 0 } }] })
  mocks.deleteRows.mockResolvedValue(null)
})
it('shows only public demos for guests and hides deletion', async () => {
  mount()
  expect(await screen.findByRole('button', { name: 'Demo v1.0.0 선택' })).toBeInTheDocument()
  expect(screen.queryByText('Latest')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument()
})
it('selects previous versions in a modal without replacing the representative card', async () => {
  const actions = mount({ id: 'owner', roles: [], is_active: true } as unknown as UserData)
  fireEvent.click(await screen.findByRole('button', { name: 'Latest 버전 목록' }))
  const dialog = screen.getByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Previous v1.0.0 선택' }))
  expect(actions.onSelect).toHaveBeenCalledWith(old)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Latest v1.1.0 선택' })).toBeInTheDocument()
  expect(screen.getByLabelText('Experiment 정렬')).toHaveValue('created-desc')
})
it('confirms linked data and deletes only the selected version, promoting the previous card', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
  const actions = mount({ id: 'owner', roles: [], is_active: true } as unknown as UserData, 2)
  await screen.findByRole('button', { name: 'Latest v1.1.0 삭제' })
  mocks.available.mockResolvedValue({ mine: [old], demos: [demo] })
  fireEvent.click(screen.getByRole('button', { name: 'Latest v1.1.0 삭제' }))
  await waitFor(() => expect(actions.onDeleteSelected).toHaveBeenCalledWith(latest))
  expect(mocks.deleteRows).toHaveBeenCalledWith([2])
  expect(confirm.mock.calls[0][0]).toContain('Measurement 2')
  expect(await screen.findByRole('button', { name: 'Previous v1.0.0 선택' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Demo v1.0.0 삭제' })).not.toBeInTheDocument()
})
