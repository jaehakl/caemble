// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { authQueryKey, useLogout } from './use-auth'

const api = vi.hoisted(() => ({ fetchMe: vi.fn(), logout: vi.fn() }))

vi.mock('@/api', () => ({
  dbTables: { User: { fetchMe: api.fetchMe } },
  logout: api.logout,
}))

describe('auth cache', () => {
  it('clears the authenticated user and work cache after logout', async () => {
    api.logout.mockResolvedValue({ ok: true })
    const queryClient = new QueryClient()
    queryClient.setQueryData(authQueryKey, { id: 'user-1' })
    queryClient.setQueryData(['work', 'structures'], ['cached'])
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const logout = renderHook(() => useLogout(), { wrapper })

    await act(async () => {
      await logout.result.current.mutateAsync()
    })

    expect(queryClient.getQueryData(authQueryKey)).toBeNull()
    expect(queryClient.getQueriesData({ queryKey: ['work'] })).toEqual([])
  })
})
