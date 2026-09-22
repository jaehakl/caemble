import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminPage } from './AdminRoute'
import { SettingsPage } from './SettingsRoute'

const mocks = vi.hoisted(() => ({
  authenticated: true,
  pending: false,
  roles: [] as string[],
}))
vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: mocks.authenticated,
    isPending: mocks.pending,
    user: mocks.authenticated ? { id: 'user', roles: mocks.roles } : null,
  }),
}))
vi.mock('@/features/cae-workbench/AdminWorkspace', () => ({
  AdminWorkspace: () => <section>Admin workspace</section>,
}))
vi.mock('@/features/launchers/LaunchersPage', () => ({
  LaunchersWorkspace: () => <section>Launchers workspace</section>,
}))
vi.mock('@/features/jobs/JobsPage', () => ({ JobsWorkspace: () => <section>Jobs workspace</section> }))
vi.mock('@/features/cae/CaeBatchPanel', () => ({ CaeBatchPanel: () => <section>CAE Jobs workspace</section> }))

function mount(component: ReactNode, address: string) {
  return render(<MemoryRouter initialEntries={[address]}>{component}</MemoryRouter>)
}

describe('standalone routes', () => {
  beforeEach(() => {
    mocks.authenticated = true
    mocks.pending = false
    mocks.roles = []
  })

  it('renders all three Setting workspaces at once without a Viewer', () => {
    mount(<SettingsPage />, '/settings')
    expect(screen.getByText('Launchers workspace')).toBeInTheDocument()
    expect(screen.getByText('Jobs workspace')).toBeInTheDocument()
    expect(screen.getByText('CAE Jobs workspace')).toBeInTheDocument()
    expect(screen.queryByText(/Viewer/i)).not.toBeInTheDocument()
  })

  it('returns a 404 for a non-admin and renders the workspace for an admin', () => {
    const page = mount(<AdminPage />, '/admin')
    expect(screen.getByText('404')).toBeInTheDocument()
    mocks.roles = ['admin']
    page.rerender(
      <MemoryRouter initialEntries={['/admin']}>
        <AdminPage />
      </MemoryRouter>,
    )
    expect(screen.getByText('Admin workspace')).toBeInTheDocument()
  })
})
