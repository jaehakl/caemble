// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JobsPage } from './JobsPage'

const api = vi.hoisted(() => ({ kill: vi.fn(), list: vi.fn() }))

vi.mock('@/api', () => ({ dbTables: { Job: api } }))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'user-1', roles: ['user'] } }),
}))

const runningJob = {
  id: 'job-1',
  user_id: 'user-1',
  handler_type: 'cae.simulation.start',
  slave_app_id: 'cae',
  state: 'running',
  launcher_id: 'launcher-1',
  latest_progress: {
    time: '2031-04-05T06:07:08Z',
    progress: {
      stage: 'solve',
      completed: 42,
      total: 100,
      detail: `<script>alert('unsafe')</script>${'x'.repeat(160)}`,
    },
  },
  attempt_count: 1,
  created_at: '2026-08-07T00:00:00Z',
  started_at: '2026-08-07T00:00:02Z',
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <JobsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('JobsPage', () => {
  beforeEach(() => {
    api.list.mockReset()
    api.list.mockResolvedValue([runningJob])
    api.kill.mockReset()
    api.kill.mockResolvedValue({ ok: true })
  })

  it('lists active jobs and requests cancellation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('cae.simulation.start')).toBeVisible()
    const progress = screen.getByText((content) => content.startsWith('{"stage":"solve"'))
    expect(progress.textContent).toHaveLength(96)
    expect(progress).toHaveTextContent(/…$/)
    expect(screen.getByText(/2031/)).toBeVisible()
    expect(document.querySelector('script')).toBeNull()
    await user.click(screen.getByRole('button', { name: '중단' }))

    await waitFor(() => expect(api.kill).toHaveBeenCalledWith('job-1'))
    expect(api.list).toHaveBeenCalledWith(true)
  })

  it('renders arbitrary primitive progress as escaped, compact text', async () => {
    api.list.mockResolvedValue([
      {
        ...runningJob,
        id: 'job-string',
        latest_progress: {
          time: '2031-04-05T06:07:08Z',
          progress: '<img src=x onerror=alert(1)>',
        },
      },
      {
        ...runningJob,
        id: 'job-number',
        latest_progress: {
          time: '2031-04-05T06:07:09Z',
          progress: 42,
        },
      },
    ])
    renderPage()

    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeVisible()
    expect(screen.getByText('42')).toBeVisible()
    expect(document.querySelector('img')).toBeNull()
  })
})
