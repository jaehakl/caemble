// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExperimentManager } from './ExperimentManager'

const mocks = vi.hoisted(() => ({
  deleteRows: vi.fn(async () => undefined),
  getExperiment: vi.fn(),
  listExperiments: vi.fn(),
  listRows: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  usage: vi.fn(),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return {
    ...actual,
    dbTables: {
      ...actual.dbTables,
      Experiment: {
        ...actual.dbTables.Experiment,
        deleteRows: mocks.deleteRows,
        listRows: mocks.listRows,
        usage: mocks.usage,
      },
    },
  }
})
vi.mock('@/api/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/catalog')>()
  return {
    ...actual,
    catalogApi: { ...actual.catalogApi, getExperiment: mocks.getExperiment, listExperiments: mocks.listExperiments },
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }))

Object.defineProperties(HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  releasePointerCapture: { configurable: true, value: () => undefined },
  setPointerCapture: { configurable: true, value: () => undefined },
})
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
})

const sourceBundle = {
  formatVersion: 6 as const,
  files: {
    'experiment.tsx': 'export default experiment({})',
    'geometry.tsx': 'export {}',
    'material.tsx': 'export {}',
    'simulate.py': 'async def simulate(*, sim, tasks, vars): pass',
  },
}
const derivedCounts = { measurements: 1, recordedData: 2, designerModels: 0, predictorModels: 0 }
const rows = [
  {
    id: 2,
    user_id: 'user-1',
    namespace: 'jlee',
    repository_slug: 'lab',
    experiment_key: 'plate',
    version_major: 1,
    version_minor: 1,
    version_patch: 0,
    name: 'Plate',
    description: 'Saved plate description that remains readable in the compact Workbench list.',
    source_bundle: sourceBundle,
    source_hash: 'b'.repeat(64),
    version: '1.1.0',
    coordinate: 'caemble:experiment/jlee/lab/plate@1.1.0',
    sourceLocked: false,
    derivedCounts: { measurements: 0, recordedData: 0, designerModels: 0, predictorModels: 0 },
  },
  {
    id: 1,
    user_id: 'user-1',
    namespace: 'jlee',
    repository_slug: 'lab',
    experiment_key: 'plate',
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
    name: 'Plate',
    description: null,
    source_bundle: sourceBundle,
    source_hash: 'a'.repeat(64),
    version: '1.0.0',
    coordinate: 'caemble:experiment/jlee/lab/plate@1.0.0',
    sourceLocked: true,
    derivedCounts,
  },
]

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {children}
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listExperiments.mockResolvedValue({
    total: 1,
    nextCursor: null,
    items: [
      {
        key: 'basketball-goal',
        namespace: 'caemble',
        repository: 'getting-started',
        version: '1.0.0',
        coordinate: 'caemble:experiment/caemble/getting-started/basketball-goal@1.0.0',
        title: 'Basketball Goal',
        description: 'Basketball structure Example description.',
        cadApiVersion: 9,
        sourceFormatVersion: 2,
        bundleFormatVersion: 6,
        bundleHash: 'c'.repeat(64),
        concepts: [],
        relatedSolvers: [],
      },
    ],
  })
  mocks.getExperiment.mockResolvedValue({
    key: 'basketball-goal',
    namespace: 'caemble',
    repository: 'getting-started',
    version: '1.0.0',
    coordinate: 'caemble:experiment/caemble/getting-started/basketball-goal@1.0.0',
    title: 'Basketball Goal',
    description: 'Basketball structure Example description.',
    sourceBundle,
  })
  mocks.listRows.mockResolvedValue({ total: rows.length, items: rows })
  mocks.usage.mockResolvedValue({ items: [{ experimentId: 1, sourceLocked: true, derivedCounts }] })
})

describe('ExperimentManager', () => {
  it('shows abbreviated descriptions without exposing coordinates and keeps SemVer lock impact', async () => {
    const user = userEvent.setup()
    const onOpenExample = vi.fn()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={onOpenExample}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    const exampleDescription = await screen.findByText('Basketball structure Example description.')
    expect(exampleDescription).toBeVisible()
    expect(exampleDescription).toHaveClass('line-clamp-2')
    expect(exampleDescription).toHaveAttribute('title', 'Basketball structure Example description.')
    await user.click(screen.getByText('Basketball Goal').closest('button')!)
    await waitFor(() =>
      expect(mocks.getExperiment).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'basketball-goal',
          namespace: 'caemble',
          repository: 'getting-started',
          version: '1.0.0',
        }),
      ),
    )
    expect(onOpenExample).toHaveBeenCalledWith(
      sourceBundle,
      'Basketball Goal',
      'Basketball structure Example description.',
    )
    expect(
      await screen.findByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).toBeVisible()
    expect(screen.getByText('설명 없음')).toBeVisible()
    expect(screen.getByText('v1.1.0')).toBeVisible()
    expect(screen.getAllByText('v1.0.0')).toHaveLength(2)
    expect(screen.getByText('Locked')).toBeVisible()
    expect(screen.getByText('연결 데이터 3')).toBeVisible()
    expect(screen.queryByText('caemble/getting-started/basketball-goal')).not.toBeInTheDocument()
    expect(
      screen.queryByText('caemble:experiment/caemble/getting-started/basketball-goal@1.0.0'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('jlee/lab/plate')).not.toBeInTheDocument()
    expect(screen.queryByText('caemble:experiment/jlee/lab/plate@1.1.0')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('이름 또는 설명 검색')).toBeVisible()
    expect(screen.queryByText(/Example과 저장된 namespace/)).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '소유 범위' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('filters the unified list by namespace and repository', async () => {
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(
      await screen.findByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).toBeVisible()
    expect(screen.getByText('Basketball structure Example description.')).toBeVisible()

    screen.getByRole('combobox', { name: 'Namespace 필터' }).focus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(
      screen.queryByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Basketball structure Example description.')).toBeVisible()

    screen.getByRole('combobox', { name: 'Namespace 필터' }).focus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    screen.getByRole('combobox', { name: 'Repository 필터' }).focus()
    await user.keyboard('{Enter}{ArrowDown}{Enter}')
    expect(
      screen.getByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).toBeVisible()
    expect(screen.queryByText('Basketball structure Example description.')).not.toBeInTheDocument()
  })

  it('keeps saved Experiment scope fixed to mine without showing an owner scope control to admins', async () => {
    render(
      <ExperimentManager
        authenticated
        selectedId={null}
        user={{ id: 'admin-1', roles: ['admin'], experiment_namespaces: ['admin-space'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(
      await screen.findByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).toBeVisible()
    expect(screen.queryByRole('combobox', { name: '소유 범위' })).not.toBeInTheDocument()
    expect(mocks.listRows).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mine' }))
  })

  it('keeps saved results available when the Example query fails', async () => {
    mocks.listExperiments.mockRejectedValueOnce(new Error('example failed'))
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(await screen.findByText('Example 목록을 불러오지 못했습니다.')).toBeVisible()
    expect(
      await screen.findByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).toBeVisible()
  })

  it('keeps Examples available when the saved query fails', async () => {
    mocks.listRows.mockRejectedValueOnce(new Error('saved failed'))
    render(
      <ExperimentManager
        authenticated
        selectedId={null}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(await screen.findByText('저장된 Experiment 목록을 불러오지 못했습니다.')).toBeVisible()
    expect(await screen.findByText('Basketball structure Example description.')).toBeVisible()
  })

  it('loads only Examples for unauthenticated users', async () => {
    render(
      <ExperimentManager
        authenticated={false}
        selectedId={null}
        user={null}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(await screen.findByText('Basketball structure Example description.')).toBeVisible()
    expect(mocks.listRows).not.toHaveBeenCalled()
    expect(
      screen.queryByText('Saved plate description that remains readable in the compact Workbench list.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Experiment namespace' })).not.toBeInTheDocument()
  })

  it('does not show namespace management controls and deletes one Version after usage confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const props = {
      authenticated: true,
      selectedId: 2,
      onOpenExample: vi.fn(),
      onOpenSaved: vi.fn(),
    }
    const { rerender } = render(<ExperimentManager {...props} user={null} />, { wrapper })

    rerender(
      <ExperimentManager
        {...props}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['late-user'] } as never}
      />,
    )
    expect(screen.queryByRole('textbox', { name: 'Experiment namespace' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Namespace 저장' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Plate v1.0.0 삭제' }))

    await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith([1]))
    expect(mocks.deleteRows).toHaveBeenCalledWith([1])
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('연결 데이터 3개도 함께 삭제'))
  })

  it('shows usage lookup failures before deletion', async () => {
    mocks.usage.mockRejectedValueOnce(new Error('usage failed'))
    const confirm = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    await user.click(await screen.findByRole('button', { name: 'Plate v1.0.0 삭제' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('usage failed'))
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.deleteRows).not.toHaveBeenCalled()
  })

  it('shows delete request failures', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    mocks.deleteRows.mockRejectedValueOnce(new Error('delete failed'))
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespaces: ['jlee'] } as never}
        onOpenExample={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    await user.click(await screen.findByRole('button', { name: 'Plate v1.0.0 삭제' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('delete failed'))
    expect(mocks.deleteRows).toHaveBeenCalledWith([1])
  })
})
