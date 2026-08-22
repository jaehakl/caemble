// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LaunchersWorkspace } from './LaunchersPage'

const api = vi.hoisted(() => ({
  cancelCurrentJob: vi.fn(),
  list: vi.fn(),
  reconcile: vi.fn(),
  resetWorker: vi.fn(),
  runtime: vi.fn(),
}))

vi.mock('@/api', () => ({ dbTables: { Launcher: api } }))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'user-1', roles: ['user'] } }),
}))
vi.mock('@/features/runtime/manifests', () => ({
  bundledSlaveManifests: [{ id: 'cae', name: 'CAE', module: 'app', startup_timeout_seconds: 60 }],
}))

function renderPage(compact = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <LaunchersWorkspace compact={compact} />
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('LaunchersWorkspace', () => {
  beforeEach(() => {
    api.list.mockReset()
    api.list.mockResolvedValue({
      total: 1,
      items: [
        {
          id: 'launcher-1',
          user_id: 'user-1',
          launcher_name: 'workstation',
          status: 'busy',
          slave_app_ids: ['cae', 'ai'],
          last_heartbeat_at: '2026-08-07T00:00:00Z',
        },
      ],
    })
    api.runtime.mockReset()
    api.runtime.mockResolvedValue([
      {
        launcher_id: 'launcher-1',
        current_job_id: 'job-1',
        loaded_slave_app_id: 'cae',
        worker_status: 'running',
        resetting: false,
        metadata: {},
      },
    ])
    api.cancelCurrentJob.mockReset()
    api.cancelCurrentJob.mockResolvedValue({ ok: true })
    api.resetWorker.mockReset()
    api.resetWorker.mockResolvedValue({ ok: true })
    api.reconcile.mockReset()
    api.reconcile.mockResolvedValue({ ok: true, launchers: 0 })
  })

  it('shows launcher runtime and cancels its active job', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('workstation')).toBeVisible()
    expect(screen.getByText('job-1')).toBeVisible()
    expect(screen.getByText('Bundled apps · CAE')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '취소' }))

    await waitFor(() => expect(api.cancelCurrentJob).toHaveBeenCalledWith('launcher-1'))
  })

  it('renders the same runtime controls as a compact Settings pane', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderPage(true)

    const list = await screen.findByRole('list', { name: 'Launcher 목록' })
    expect(list).toHaveTextContent('workstation')
    expect(list).toHaveTextContent('job-1')
    expect(screen.queryByRole('columnheader')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(api.resetWorker).toHaveBeenCalledWith('launcher-1'))
  })
})
