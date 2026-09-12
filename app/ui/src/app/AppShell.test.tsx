import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppShell } from './AppShell'

const auth = vi.hoisted(() => ({ user: null as null | { roles: string[] } }))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => auth }))

function mount(path = '/workbench') {
  return render(
    <TooltipProvider delayDuration={0}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="*" element={<p>Page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  )
}

describe('AppShell', () => {
  it('renders the icon-only routes in order with active state and tooltips', async () => {
    auth.user = null
    mount()
    const links = screen.getAllByRole('link')
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Showcase',
      'Workbench',
      'Documentation',
      'Lab',
      'Setting',
      'Account',
    ])
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument()
    await userEvent.hover(screen.getByRole('link', { name: 'Documentation' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Documentation')
  })

  it('shows Admin only to administrators', () => {
    auth.user = { roles: ['admin'] }
    mount('/admin')
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('aria-current', 'page')
  })
})
