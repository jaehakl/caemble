import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { UserData } from '@/api'
import { AdminWorkspace } from './AdminWorkspace'

const mocks = vi.hoisted(() => ({
  demoCandidates: vi.fn(),
  getAllUsersAdmin: vi.fn(),
  listRows: vi.fn(),
  replaceDemos: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Experiment: {
      demoCandidates: mocks.demoCandidates,
      listRows: mocks.listRows,
      replaceDemos: mocks.replaceDemos,
    },
    User: { getAllUsersAdmin: mocks.getAllUsersAdmin },
  },
  getListRequest: () => ({ filter: {} }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAllUsersAdmin.mockResolvedValue([])
  mocks.listRows.mockResolvedValue({ items: [], total: 0 })
  mocks.demoCandidates.mockResolvedValue({
    items: [
      {
        id: 7,
        name: 'Geometry only',
        predictionReady: false,
        predictionCounts: { recordedMeasurements: 0, readyCalculations: 0, calculationData: 0 },
        isDemo: false,
        demoOrder: null,
        demoDefault: false,
      },
    ],
  })
  mocks.replaceDemos.mockResolvedValue({ mine: [], demos: [] })
})

it('allows an Experiment without prediction data to be added and saved as the default Demo', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <AdminWorkspace
        currentUser={{ id: 'admin', is_active: true, roles: ['admin'] } as unknown as UserData}
        onOpenExperiment={vi.fn()}
      />
    </QueryClientProvider>,
  )

  const candidate = await screen.findByRole('option', { name: 'Geometry only · Prediction 준비 안 됨' })
  expect(candidate).toBeEnabled()

  fireEvent.change(screen.getByLabelText('Experiment 선택', { selector: 'select' }), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button', { name: '추가' }))
  fireEvent.click(screen.getByRole('button', { name: '저장' }))

  await waitFor(() => expect(mocks.replaceDemos).toHaveBeenCalledWith([7], 7))
})
