import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { LaunchersWorkspace } from './LaunchersPage'

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  reset: vi.fn(),
  stopAll: vi.fn(),
  invalidate: vi.fn(),
  warning: null as string | null,
}))
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
            gpu_devices: [
              {
                uuid: 'GPU-a',
                total_bytes: 24 * 1024 ** 3,
                vram_reserved_bytes: 12 * 1024 ** 3,
                vram_monitoring_warning: mocks.warning,
              },
            ],
            vram_monitoring_warning: mocks.warning,
          },
          instances: [1, 2].map((index) => ({
            instance_id: `instance-${index}`,
            job_id: `job-${index}`,
            slave_app_id: 'cae',
            state: 'running',
            attempt_count: index,
            allocation: { cpu_cores: 4, gpu_devices: ['GPU-a'], vram_budget_bytes: { 'GPU-a': 6 * 1024 ** 3 } },
            vram_used_bytes: mocks.warning ? null : { 'GPU-a': 1024 ** 3 },
            vram_monitoring_warning: mocks.warning,
            ram_used_bytes: 1024 ** 3,
          })),
        },
      ],
    },
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.warning = null
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

it('shows monitoring warnings without disabling running jobs and clears them on recovery', () => {
  mocks.warning = 'GPU 메모리 감시 불가: 기존 작업은 계속 실행됩니다.'
  const view = render(<LaunchersWorkspace />)
  expect(screen.getAllByRole('alert')).toHaveLength(4)
  expect(screen.getByText(/VRAM 예약 \/ 전체 12.0 GiB \/ 24.0 GiB/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Job job-1 취소' })).toBeEnabled()
  expect(screen.getAllByText(/VRAM 실측 \/ 예산 관측 대기 \/ 6.0 GiB/)).toHaveLength(2)
  mocks.warning = null
  view.rerender(<LaunchersWorkspace />)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getAllByText(/VRAM 실측 \/ 예산 1.0 GiB \/ 6.0 GiB/)).toHaveLength(2)
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
