import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { expect, it, vi } from 'vitest'
import { Component } from './StartRoute'

const auth = vi.hoisted(() => ({ isPending: false, isAuthenticated: false }))
vi.mock('@/features/auth/use-auth', () => ({ useAuth: () => auth }))
function Destination() {
  const location = useLocation()
  return (
    <p>
      {location.pathname}
      {location.search}
    </p>
  )
}
function mount(address = '/') {
  render(
    <MemoryRouter initialEntries={[address]}>
      <Routes>
        <Route path="/" element={<Component />} />
        <Route path="*" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  )
}
it('waits for authentication', () => {
  auth.isPending = true
  mount()
  expect(screen.getByRole('status')).toBeInTheDocument()
})
it('sends guests to showcase', () => {
  auth.isPending = false
  auth.isAuthenticated = false
  mount()
  expect(screen.getByText('/showcase')).toBeInTheDocument()
})
it('sends authenticated users to workbench', () => {
  auth.isPending = false
  auth.isAuthenticated = true
  mount()
  expect(screen.getByText('/workbench')).toBeInTheDocument()
})
it.each(['experiment=12', 'help=manual&item=workbench-quickstart'])(
  'preserves legacy intent before auth: %s',
  (query) => {
    auth.isPending = true
    mount(`/?${query}`)
    expect(screen.getByText(`/workbench?${query}`)).toBeInTheDocument()
  },
)
