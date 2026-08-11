// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider } from 'react-router/dom'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppRouter } from './router'

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

describe('single-page router', () => {
  it.each([
    '/cae',
    '/analysis',
    '/ai/chat',
    '/launchers',
    '/jobs',
    '/materials',
    '/account',
    '/login',
    '/docs',
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
