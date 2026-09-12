import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { SavedExperimentRecord, UserData } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { SaveExperimentDialog } from './SaveExperimentDialog'

const mocks = vi.hoisted(() => ({ available: vi.fn() }))
vi.mock('@/api', () => ({ dbTables: { Experiment: mocks } }))
vi.mock('./ExperimentShowcase', () => ({
  ExperimentShowcase: ({
    onSelect,
    selectedId,
    revealId,
  }: {
    onSelect: (row: unknown) => void
    selectedId: number
    revealId: number
  }) => (
    <div>
      <button
        onClick={() =>
          onSelect({
            id: 9,
            namespace: 'owner',
            repository_slug: 'target',
            experiment_key: 'destination',
            name: 'Destination name',
            source_hash: 'hash',
          })
        }
      >
        Select destination
      </button>
      <output aria-label="Saved card">
        {selectedId}:{revealId}
      </output>
    </div>
  ),
}))
const user = { id: 'owner', roles: [], is_active: true } as unknown as UserData
function mount(existing: SavedExperimentRecord | null = null) {
  const onSaved = vi.fn(),
    onClose = vi.fn(),
    saveExperiment = vi.fn().mockResolvedValue({ id: 12, version: '0.1.1' })
  const workbench = {
    experimentRecord: { id: 1, namespace: 'owner', repository_slug: 'repo', experiment_key: 'original' },
    experimentNamespaces: ['owner'],
    experimentName: 'Current name',
    experimentDescription: '현재 설명',
    experiment: { sourceBundle: { files: {} } },
    saveExperiment,
  } as unknown as CaeWorkbenchState
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SaveExperimentDialog
        user={user}
        workbench={workbench}
        initialTarget={existing}
        capture={null}
        captureError="빈 Viewer"
        includePreflight
        setIncludePreflight={vi.fn()}
        preflightReason="결과 없음"
        onSaved={onSaved}
        onClose={onClose}
      />
    </QueryClientProvider>,
  )
  return { saveExperiment, onSaved, onClose }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.available.mockResolvedValue({ mine: [], demos: [] })
})
it('starts as a copy and keeps current metadata when choosing a version destination', async () => {
  const test = mount()
  expect(screen.getByLabelText('key')).toHaveValue('original-copy')
  fireEvent.click(screen.getByRole('button', { name: 'Select destination' }))
  expect(screen.getByLabelText('key')).toHaveValue('destination')
  expect(screen.getByLabelText('key')).toBeDisabled()
  expect(screen.getByLabelText('이름')).toHaveValue('Current name')
  expect(screen.getByLabelText('설명')).toHaveValue('현재 설명')
  expect(screen.getByLabelText('Version 증가')).toHaveValue('patch')
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  await waitFor(() => expect(test.onSaved).toHaveBeenCalledOnce())
  expect(test.saveExperiment).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Current name', key: 'destination', bump: 'patch' }),
    'new_version',
    expect.objectContaining({ target: expect.objectContaining({ id: 9 }), requestId: expect.any(String) }),
  )
  expect(screen.getByLabelText('Saved card')).toHaveTextContent('12:12')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(test.onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
  fireEvent.click(screen.getAllByRole('button', { name: '닫기' })[0])
  expect(test.onClose).toHaveBeenCalledOnce()
})
it('explains duplicate keys before submitting and lets New Experiment clear the destination', async () => {
  mocks.available.mockResolvedValue({
    mine: [{ namespace: 'owner', repository_slug: 'repo', experiment_key: 'original-copy' }],
    demos: [],
  })
  const test = mount()
  expect(await screen.findByRole('alert')).toHaveTextContent('이미 사용 중인')
  expect(screen.getByRole('button', { name: '저장' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Select destination' }))
  fireEvent.click(screen.getByRole('button', { name: '새 Experiment' }))
  expect(screen.getByLabelText('key')).toBeEnabled()
  expect(screen.getByLabelText('key')).toHaveValue('original-copy')
  expect(test.saveExperiment).not.toHaveBeenCalled()
})
it('retries a lost response with the same request even when refresh reveals the saved key', async () => {
  const test = mount()
  test.saveExperiment.mockRejectedValueOnce(new Error('response lost'))
  await waitFor(() => expect(screen.getByRole('button', { name: '저장' })).toBeEnabled())
  mocks.available.mockResolvedValue({
    mine: [{ namespace: 'owner', repository_slug: 'repo', experiment_key: 'original-copy' }],
    demos: [],
  })
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('response lost')
  await waitFor(() => expect(mocks.available).toHaveBeenCalledTimes(2))
  expect(screen.getByRole('button', { name: '저장' })).toBeEnabled()
  const args = test.saveExperiment.mock.calls[0]
  fireEvent.click(screen.getByRole('button', { name: '저장' }))
  await waitFor(() => expect(test.onSaved).toHaveBeenCalledOnce())
  expect(test.saveExperiment.mock.calls[1]).toEqual(args)
})
