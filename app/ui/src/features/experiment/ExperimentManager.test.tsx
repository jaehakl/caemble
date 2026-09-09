import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import type { UserData } from '@/api'
import { ExperimentManager } from './ExperimentManager'

const mocks = vi.hoisted(() => ({ available: vi.fn(), examples: vi.fn(), detail: vi.fn() }))
vi.mock('./queryOptions', () => ({
  availableExperimentsQueryOptions: () => ({ queryKey: ['manager-test'], queryFn: mocks.available }),
}))
vi.mock('@/features/catalog/queryOptions', () => ({
  catalogExperimentsQueryOptions: (query: { q: string }, enabled: boolean) => ({
    queryKey: ['examples-test', query.q],
    queryFn: () => mocks.examples(query),
    enabled,
  }),
}))
vi.mock('@/api/catalog', () => ({ catalogApi: { getExperiment: mocks.detail } }))

function row(id: number, namespace: string, isDemo = false) {
  return {
    id,
    namespace,
    name: `Experiment ${id}`,
    description: '',
    repository_slug: `repo-${id}`,
    experiment_key: `key-${id}`,
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
    user_id: 'owner',
    isDemo,
  }
}
function mount(compact = false, selectedId: number | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onOpenSaved = vi.fn()
  const onOpenExample = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <ExperimentManager
        authenticated
        user={{ id: 'owner', is_active: true, roles: [] } as unknown as UserData}
        compact={compact}
        selectedId={selectedId}
        onOpenSaved={onOpenSaved}
        onOpenExample={onOpenExample}
      />
    </QueryClientProvider>,
  )
  return { client, onOpenSaved, onOpenExample }
}
beforeEach(() => {
  mocks.available.mockResolvedValue({
    mine: [row(1, 'zeta'), row(2, 'beta')],
    demos: [row(2, 'beta'), row(3, 'alpha', true)],
  })
  mocks.examples.mockResolvedValue({
    items: [
      {
        namespace: 'caemble',
        repository: 'samples',
        key: 'heat',
        version: '1.0.0',
        coordinate: 'caemble:experiment/caemble/samples/heat@1.0.0',
        title: 'Heat example',
        description: '',
      },
    ],
  })
  mocks.detail.mockResolvedValue({
    sourceBundle: {},
    title: 'Heat example',
    description: '',
    calculations: [{ name: 'Mean', source_code: 'export default () => 1' }],
  })
})
it('orders and deduplicates namespaces and opens the active source', async () => {
  const user = userEvent.setup()
  const { onOpenSaved, onOpenExample } = mount()
  await screen.findByText('Experiment 2')
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['beta', 'zeta', 'alpha', '예제'])
  expect(screen.getByRole('tab', { name: 'beta' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByLabelText('Namespace 필터')).not.toBeInTheDocument()
  expect(screen.getAllByText('Experiment 2')).toHaveLength(1)
  expect(screen.queryByText('Experiment 1')).not.toBeInTheDocument()
  await user.click(screen.getByText('Experiment 2'))
  expect(onOpenSaved).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  await user.click(screen.getByRole('tab', { name: '예제' }))
  await user.click(await screen.findByRole('button', { name: /Heat example/ }))
  await waitFor(() =>
    expect(onOpenExample).toHaveBeenCalledWith({}, 'Heat example', '', [
      { name: 'Mean', source_code: 'export default () => 1' },
    ]),
  )
  expect(screen.queryByText('Experiment 2')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument()
})
it('keeps tabs and independent searches when search returns no results', async () => {
  const user = userEvent.setup()
  mount(true)
  await screen.findByText('Experiment 2')
  await user.type(screen.getByRole('textbox'), 'missing')
  expect(screen.getByText('조건에 맞는 Experiment가 없습니다.')).toBeInTheDocument()
  expect(screen.getAllByRole('tab')).toHaveLength(4)
  await user.click(screen.getByRole('tab', { name: 'zeta' }))
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(screen.getByText('Experiment 1')).toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: 'beta' }))
  expect(screen.getByRole('textbox')).toHaveValue('missing')
})
it('preserves selection on refresh and falls back after the namespace disappears', async () => {
  const user = userEvent.setup()
  const { client } = mount()
  await screen.findByText('Experiment 2')
  await user.click(screen.getByRole('tab', { name: 'zeta' }))
  act(() => client.setQueryData(['manager-test'], { mine: [row(1, 'zeta'), row(4, 'aardvark')], demos: [] }))
  expect(screen.getByRole('tab', { name: 'zeta' })).toHaveAttribute('aria-selected', 'true')
  act(() => client.setQueryData(['manager-test'], { mine: [row(4, 'aardvark')], demos: [] }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'aardvark' })).toHaveAttribute('aria-selected', 'true'))
})
it('defaults to demos then examples without owned experiments', async () => {
  mocks.available.mockResolvedValue({ mine: [], demos: [row(3, 'demo', true)] })
  const { client } = mount()
  await screen.findByText('Experiment 3')
  expect(screen.getByRole('tab', { name: 'demo' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText('Demo · 읽기 전용')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument()
  act(() => client.setQueryData(['manager-test'], { mine: [], demos: [] }))
  await waitFor(() => expect(screen.getByRole('tab', { name: '예제' })).toHaveAttribute('aria-selected', 'true'))
})

it('keeps repository selection per namespace and supports arrow-key navigation', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const user = userEvent.setup()
  mount()
  await screen.findByText('Experiment 2')
  screen.getByRole('combobox').focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: 'repo-2' }))
  expect(screen.getByRole('combobox')).toHaveTextContent('repo-2')
  screen.getByRole('tab', { name: 'beta' }).focus()
  await user.keyboard('{ArrowRight}')
  expect(screen.getByRole('tab', { name: 'zeta' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('combobox')).toHaveTextContent('모든 repository')
  await user.keyboard('{ArrowLeft}')
  expect(screen.getByRole('combobox')).toHaveTextContent('repo-2')
})

it('isolates catalog errors from saved namespaces', async () => {
  mocks.examples.mockRejectedValue(new Error('offline'))
  const user = userEvent.setup()
  mount()
  await screen.findByText('Experiment 2')
  await user.click(screen.getByRole('tab', { name: '예제' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('예제 목록을 불러오지 못했습니다.')
  await user.click(screen.getByRole('tab', { name: 'beta' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('Experiment 2')).toBeInTheDocument()
})

it('waits for the saved list before selecting the initial namespace', async () => {
  let resolveAvailable!: (value: { mine: ReturnType<typeof row>[]; demos: ReturnType<typeof row>[] }) => void
  mocks.available.mockReturnValue(
    new Promise((resolve) => {
      resolveAvailable = resolve
    }),
  )
  mount()
  expect(screen.getByRole('tab', { name: '예제' })).toHaveAttribute('aria-selected', 'false')
  expect(screen.getByText('Experiment 목록을 불러오는 중…')).toBeInTheDocument()
  await act(async () => resolveAvailable({ mine: [row(1, 'owner')], demos: [] }))
  await waitFor(() => expect(screen.getByRole('tab', { name: 'owner' })).toHaveAttribute('aria-selected', 'true'))
})

it('reveals a restored Experiment namespace without preventing later tab browsing', async () => {
  const user = userEvent.setup()
  mount(false, 1)
  await waitFor(() => expect(screen.getByRole('tab', { name: 'zeta' })).toHaveAttribute('aria-selected', 'true'))
  expect(screen.getByText('Experiment 1')).toBeInTheDocument()
  await user.click(screen.getByRole('tab', { name: 'beta' }))
  expect(screen.getByRole('tab', { name: 'beta' })).toHaveAttribute('aria-selected', 'true')
})
