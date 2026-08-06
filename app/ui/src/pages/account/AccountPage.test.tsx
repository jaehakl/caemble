// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountPage } from './AccountPage'

const state = vi.hoisted(() => ({
  deleteConnection: vi.fn(),
  saveConnection: vi.fn(),
  user: null as null | {
    id: string
    email: string
    display_name: string
    picture_url: null
    is_active: true
    created_at: string
    updated_at: string
    roles: string[]
    gpstation_connection: null | { api_base_url: string; access_token: string }
  },
  validateConnection: vi.fn(),
}))

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: state.user,
  }),
  useDeleteGpStationConnection: () => ({
    isPending: false,
    mutateAsync: state.deleteConnection,
  }),
  useSaveGpStationConnection: () => ({
    isPending: false,
    mutateAsync: state.saveConnection,
  }),
}))

vi.mock('@/features/cae/connection', () => ({
  validateGpStationConnection: state.validateConnection,
}))

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/account']}>
      <AccountPage />
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('Account GPStation connection', () => {
  beforeEach(() => {
    state.user = {
      id: 'user-1',
      email: 'designer@example.com',
      display_name: 'Designer',
      picture_url: null,
      is_active: true,
      created_at: '2026-07-21T00:00:00Z',
      updated_at: '2026-07-21T00:00:00Z',
      roles: ['user'],
      gpstation_connection: null,
    }
    state.deleteConnection.mockReset()
    state.deleteConnection.mockResolvedValue(undefined)
    state.saveConnection.mockReset()
    state.saveConnection.mockResolvedValue(undefined)
    state.validateConnection.mockReset()
    state.validateConnection.mockResolvedValue({ hasOnlineCaeLauncher: true })
  })

  it('validates and saves the URL and token together', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('GPStation API URL'), 'https://gps.example.test')
    await user.type(screen.getByLabelText('GPStation Access Token'), 'gpsk_secret')
    await user.click(screen.getByRole('button', { name: '연결 저장' }))

    await waitFor(() =>
      expect(state.validateConnection).toHaveBeenCalledWith({
        api_base_url: 'https://gps.example.test',
        access_token: 'gpsk_secret',
      }),
    )
    expect(state.saveConnection).toHaveBeenCalledWith({
      api_base_url: 'https://gps.example.test',
      access_token: 'gpsk_secret',
    })
  })

  it('saves valid authentication and warns when no cae launcher is online', async () => {
    state.validateConnection.mockResolvedValue({ hasOnlineCaeLauncher: false })
    const user = userEvent.setup()
    renderPage()

    await user.type(screen.getByLabelText('GPStation API URL'), 'https://gps.example.test')
    await user.type(screen.getByLabelText('GPStation Access Token'), 'gpsk_secret')
    await user.click(screen.getByRole('button', { name: '연결 저장' }))

    expect(
      await screen.findByText('Token은 확인되어 저장했지만 현재 온라인 상태인 cae launcher가 없습니다.'),
    ).toBeVisible()
    expect(state.saveConnection).toHaveBeenCalledOnce()
  })

  it('deletes a stored connection without rendering its token', async () => {
    state.user!.gpstation_connection = {
      api_base_url: 'https://gps.example.test',
      access_token: 'gpsk_must_not_render',
    }
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByText('Server · https://gps.example.test')).toBeVisible()
    expect(screen.queryByText('gpsk_must_not_render')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '연결 해제' }))

    await waitFor(() => expect(state.deleteConnection).toHaveBeenCalledOnce())
  })
})
