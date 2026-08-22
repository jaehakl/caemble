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
  setNamespace: vi.fn(),
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
    experimentApi: { setNamespace: mocks.setNamespace },
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
    description: null,
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
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
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
        description: 'Example',
        cadApiVersion: 8,
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
    description: 'Example',
    sourceBundle,
  })
  mocks.listRows.mockResolvedValue({ total: rows.length, items: rows })
  mocks.usage.mockResolvedValue({ items: [{ experimentId: 1, sourceLocked: true, derivedCounts }] })
})

describe('ExperimentManager', () => {
  it('shows official coordinates and groups saved SemVer rows with lock impact', async () => {
    const user = userEvent.setup()
    const onOpenCatalog = vi.fn()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never}
        onOpenCatalog={onOpenCatalog}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    expect(await screen.findByText('caemble:experiment/caemble/getting-started/basketball-goal@1.0.0')).toBeVisible()
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
    expect(onOpenCatalog).toHaveBeenCalledWith(sourceBundle, 'Basketball Goal', 'Example')
    await user.click(screen.getByRole('tab', { name: 'Saved Experiments' }))

    expect(await screen.findByText('jlee/lab/plate')).toBeVisible()
    expect(screen.getByText('v1.1.0')).toBeVisible()
    expect(screen.getByText('v1.0.0')).toBeVisible()
    expect(screen.getByText('Locked')).toBeVisible()
    expect(screen.getByText('연결 데이터 3')).toBeVisible()
    expect(screen.queryByRole('combobox', { name: '소유 범위' })).not.toBeInTheDocument()
  })

  it('syncs asynchronously loaded namespace and deletes one Version after usage confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    const props = {
      authenticated: true,
      selectedId: 2,
      onOpenCatalog: vi.fn(),
      onOpenSaved: vi.fn(),
    }
    const { rerender } = render(<ExperimentManager {...props} user={null} />, { wrapper })

    rerender(
      <ExperimentManager
        {...props}
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'late-user' } as never}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Experiment namespace' })).toHaveValue('late-user')
    await user.click(screen.getByRole('tab', { name: 'Saved Experiments' }))
    await user.click(await screen.findByRole('button', { name: 'Plate v1.0.0 삭제' }))

    await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith([1]))
    expect(mocks.deleteRows).toHaveBeenCalledWith([1])
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('연결 데이터 3개도 함께 삭제'))
  })

  it('validates namespace input before sending it to the API', async () => {
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never}
        onOpenCatalog={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    const input = screen.getByRole('textbox', { name: 'Experiment namespace' })
    await user.clear(input)
    await user.type(input, 'Bad_Name')
    await user.click(screen.getByRole('button', { name: 'Namespace 저장' }))

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Experiment namespace는 3~32자의 소문자 영숫자와 하이픈으로 입력하세요.',
      ),
    )
    expect(mocks.setNamespace).not.toHaveBeenCalled()
  })

  it('shows namespace request failures', async () => {
    mocks.setNamespace.mockRejectedValueOnce(new Error('namespace conflict'))
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never}
        onOpenCatalog={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    const input = screen.getByRole('textbox', { name: 'Experiment namespace' })
    await user.clear(input)
    await user.type(input, 'new-space')
    await user.click(screen.getByRole('button', { name: 'Namespace 저장' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('namespace conflict'))
    expect(mocks.setNamespace).toHaveBeenCalledWith('new-space')
  })

  it('shows usage lookup failures before deletion', async () => {
    mocks.usage.mockRejectedValueOnce(new Error('usage failed'))
    const confirm = vi.spyOn(window, 'confirm')
    const user = userEvent.setup()
    render(
      <ExperimentManager
        authenticated
        selectedId={2}
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never}
        onOpenCatalog={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    await user.click(screen.getByRole('tab', { name: 'Saved Experiments' }))
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
        user={{ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never}
        onOpenCatalog={vi.fn()}
        onOpenSaved={vi.fn()}
      />,
      { wrapper },
    )

    await user.click(screen.getByRole('tab', { name: 'Saved Experiments' }))
    await user.click(await screen.findByRole('button', { name: 'Plate v1.0.0 삭제' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('delete failed'))
    expect(mocks.deleteRows).toHaveBeenCalledWith([1])
  })
})
