// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GeometryRepositoryRecord } from '@/api'
import { GeometryRepositoryManagerDialog, type GeometryRepositoryManagerState } from './GeometryRepositoryManagerDialog'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function repository(id: number, slug: string, description: string): GeometryRepositoryRecord {
  return {
    id,
    namespace: 'tester',
    slug,
    description,
    archived_at: null,
    package_count: 0,
    version_count: 0,
  } as GeometryRepositoryRecord
}

function geometry(repositories: GeometryRepositoryRecord[], archiveRepository = vi.fn(async () => undefined)) {
  return {
    archiveRepository,
    createRepository: vi.fn(),
    deleteRepository: vi.fn(),
    namespace: 'tester',
    repositories,
    restoreRepository: vi.fn(),
    updateRepositoryDescription: vi.fn(async () => undefined),
  } as unknown as GeometryRepositoryManagerState
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('GeometryRepositoryManagerDialog', () => {
  it('preserves a locally edited description when repository data refetches', async () => {
    const user = userEvent.setup()
    const initial = repository(1, 'common', 'server description')
    const state = geometry([initial])
    const view = render(
      <GeometryRepositoryManagerDialog geometry={state} onOpenChange={vi.fn()} open repositories={[initial]} />,
    )

    const input = await screen.findByLabelText('common 설명')
    await user.clear(input)
    await user.type(input, 'unsaved local description')

    const refetched = repository(1, 'common', 'new server description')
    view.rerender(
      <GeometryRepositoryManagerDialog geometry={state} onOpenChange={vi.fn()} open repositories={[refetched]} />,
    )

    expect(screen.getByLabelText('common 설명')).toHaveValue('unsaved local description')
  })

  it('tracks concurrent repository actions independently', async () => {
    const user = userEvent.setup()
    const first = deferred()
    const second = deferred()
    const archiveRepository = vi.fn((id: number) => (id === 1 ? first.promise : second.promise))
    const repositories = [repository(1, 'first', ''), repository(2, 'second', '')]
    render(
      <GeometryRepositoryManagerDialog
        geometry={geometry(repositories, archiveRepository)}
        onOpenChange={vi.fn()}
        open
      />,
    )

    const firstRow = screen.getByLabelText('first 설명').closest('tr')!
    const secondRow = screen.getByLabelText('second 설명').closest('tr')!
    await user.click(within(firstRow).getByRole('button', { name: 'Archive' }))
    expect(within(firstRow).getByRole('button', { name: 'Archive' })).toBeDisabled()
    expect(within(secondRow).getByRole('button', { name: 'Archive' })).toBeEnabled()

    await user.click(within(secondRow).getByRole('button', { name: 'Archive' }))
    expect(archiveRepository).toHaveBeenCalledTimes(2)
    expect(within(secondRow).getByRole('button', { name: 'Archive' })).toBeDisabled()

    first.resolve()
    await waitFor(() => expect(within(firstRow).getByRole('button', { name: 'Archive' })).toBeEnabled())
    expect(within(secondRow).getByRole('button', { name: 'Archive' })).toBeDisabled()
    second.resolve()
    await waitFor(() => expect(within(secondRow).getByRole('button', { name: 'Archive' })).toBeEnabled())
  })
})
