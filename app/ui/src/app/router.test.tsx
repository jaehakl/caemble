// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from 'react-router/dom'
import { afterEach, describe, expect, it } from 'vitest'
import { AppProviders } from './providers'
import { createAppRouter } from './router'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('single-page router', () => {
  it('renders the integrated public documentation route', async () => {
    window.history.replaceState(null, '', '/docs?section=reference')
    const router = createAppRouter()
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    )

    expect(await screen.findByRole('heading', { name: 'API / CAD Reference' }, { timeout: 5_000 })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/docs')
    expect(window.location.search).toBe('?section=reference')
    await router.dispose()
  })

  it.each([
    '/cae',
    '/analysis',
    '/ai/chat',
    '/launchers',
    '/jobs',
    '/materials',
    '/account',
    '/login',
    '/catalog/cad',
    '/catalog/materials',
    '/catalog/quantity-kinds',
    '/catalog/solvers',
    '/viewer',
    '/structures',
    '/experiments',
    '/examples/example',
    '/measurements',
  ])('renders Not Found for the removed URL %s without redirecting', async (path) => {
    window.history.replaceState(null, '', `${path}?legacy=1`)
    const router = createAppRouter()
    render(<RouterProvider router={router} />)

    expect(await screen.findByRole('heading', { name: '페이지를 찾을 수 없습니다' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(path)
    expect(window.location.search).toBe('?legacy=1')
    await router.dispose()
  })
})
