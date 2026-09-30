import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { LaunchersWorkspace } from './LaunchersPage'

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), reset: vi.fn(), stopAll: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/api', () => ({
  dbTables: { Launcher: { cancelInstance: mocks.cancel, resetInstance: mocks.reset, stopAll: mocks.stopAll } },
}))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isLoading: false, isAuthenticated: true, queryScope: 'user:test' }),
}))
vi.mock('@/features/runtime/queryOptions', () => ({ launchersQueryOptions: () => ({}) }))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: () => ({
    data: {
      rows: [{ id: 'launcher', launcher_name: 'Local', status: 'busy', slave_app_ids: ['cae', 'ai'] }],
      runtime: [
        {
          launcher_id: 'launcher',
          connected: true,
          recovering: false,
          resources: {
            cpu_total: 12,
            cpu_reserved: 8,
            ram_used_bytes: 2 * 1024 ** 3,
            ram_budget_bytes: 16 * 1024 ** 3,
            ram_startup_reserved_bytes: 0,
            gpu_devices: [],
          },
          instances: [1, 2].map((index) => ({
            instance_id: `instance-${index}`,
            job_id: `job-${index}`,
            slave_app_id: 'cae',
            state: 'running',
            attempt_count: index,
            allocation: { cpu_cores: 4, gpu_devices: [] },
            ram_used_bytes: 1024 ** 3,
          })),
        },
      ],
    },
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

it('cancels one instance without sending a launcher-wide stop', async () => {
  const user = userEvent.setup()
  render(<LaunchersWorkspace compact />)
  expect(screen.getByText('8 / 12')).toBeInTheDocument()
  expect(screen.getByText('2.0 GiB / 16.0 GiB')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Job job-1 취소' }))
  await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith('launcher', 'instance-1'))
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(mocks.stopAll).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Job job-2 취소' })).toBeEnabled()
})

it('exposes whole-launcher termination as a separate action', async () => {
  const user = userEvent.setup()
  render(<LaunchersWorkspace />)
  await user.click(screen.getByRole('button', { name: '전체 실행 종료' }))
  await waitFor(() => expect(mocks.stopAll).toHaveBeenCalledWith('launcher'))
  expect(mocks.cancel).not.toHaveBeenCalled()
})
