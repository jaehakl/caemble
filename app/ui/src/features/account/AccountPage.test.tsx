import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountWorkspace } from './AccountPage'

const startGoogleLogin = vi.hoisted(() => vi.fn())
vi.mock('@/api', () => ({
  dbTables: {
    AccessKey: {
      create: vi.fn(),
      list: vi.fn(),
      revoke: vi.fn(),
    },
  },
  startGoogleLogin,
}))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false, queryScope: 'public', user: null }),
  useLogout: () => ({ isPending: false, mutate: vi.fn() }),
}))

function mount(address: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[address]}>
        <AccountWorkspace />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Account login return address', () => {
  beforeEach(() => startGoogleLogin.mockReset())

  it('returns a Workbench login request to the same-origin application path', () => {
    mount('/account?returnTo=%2Fworkbench%3Fexperiment%3D7')
    fireEvent.click(screen.getByRole('button', { name: 'Google로 계속하기' }))
    expect(startGoogleLogin).toHaveBeenCalledWith('http://localhost/workbench?experiment=7')
  })

  it.each(['%2F%2Fevil.example', '%2F%5Cevil.example'])('rejects an external return address: %s', (returnTo) => {
    mount(`/account?returnTo=${returnTo}`)
    fireEvent.click(screen.getByRole('button', { name: 'Google로 계속하기' }))
    expect(startGoogleLogin).toHaveBeenCalledWith('http://localhost/account')
  })
})
