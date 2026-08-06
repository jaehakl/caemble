// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ColumnDef } from '@tanstack/react-table'
import { createMemoryRouter, Outlet } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { DataTable } from '@/components/DataTable'
import { RouteErrorPage } from '@/pages/error/RouteErrorPage'
import { AppShell } from './AppShell'

vi.mock('@/features/auth/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: false, isLoading: false, user: null }),
  useLogout: () => ({ isPending: false, mutate: vi.fn() }),
}))

const NativeRequest = globalThis.Request

afterAll(() => vi.unstubAllGlobals())
afterEach(cleanup)

describe('AppShell catalog navigation', () => {
  it('replaces the previous catalog with target pending UI until the lazy route is ready', async () => {
    vi.stubGlobal(
      'Request',
      class extends NativeRequest {
        constructor(input: RequestInfo | URL, init?: RequestInit) {
          super(input, { ...init, signal: undefined })
        }
      },
    )
    const columns: ColumnDef<{ id: string }, unknown>[] = [{ accessorKey: 'id', header: 'ID' }]
    const data = [{ id: 'CAD row' }]
    let finishLoading: (() => void) | undefined
    const router = createMemoryRouter(
      [
        {
          path: '/',
          Component: AppShell,
          hydrateFallbackElement: <div>Loading</div>,
          children: [
            {
              path: 'catalog',
              Component: Outlet,
              children: [
                {
                  path: 'cad/:tag?',
                  element: (
                    <div>
                      <div>CAD catalog content</div>
                      <DataTable columns={columns} data={data} getRowKey={(row) => row.id} />
                    </div>
                  ),
                },
                {
                  path: 'materials/:key?',
                  loader: () =>
                    new Promise<void>((resolve) => {
                      finishLoading = resolve
                    }),
                  element: <div>Material catalog content</div>,
                },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/catalog/cad'] },
    )

    render(<RouterProvider router={router} />)
    expect(await screen.findByText('CAD catalog content')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('link', { name: 'Material Catalog' }))
    await waitFor(() => expect(router.state.navigation.location?.pathname).toBe('/catalog/materials'))

    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('heading', { name: 'Material Catalog' })).toBeInTheDocument()
    expect(screen.queryByText('CAD catalog content')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Material Catalog' })).toHaveClass('bg-muted')

    act(() => finishLoading?.())
    expect(await screen.findByText('Material catalog content')).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'false')
  })

  it('keeps the app shell available when a catalog child fails', async () => {
    const router = createMemoryRouter(
      [
        {
          path: '/',
          Component: AppShell,
          hydrateFallbackElement: <div>Loading</div>,
          children: [
            { index: true, element: <div>Home content</div> },
            {
              path: 'catalog',
              Component: Outlet,
              ErrorBoundary: RouteErrorPage,
              children: [
                {
                  path: 'broken',
                  element: <div />,
                  loader: () => {
                    throw new Error('Broken catalog')
                  },
                },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/catalog/broken'] },
    )

    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: '페이지를 표시하지 못했습니다' })).toBeInTheDocument()
    expect(screen.getByText('Broken catalog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('link', { name: '홈' }))
    expect(await screen.findByText('Home content')).toBeInTheDocument()
  })
})
