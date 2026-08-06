// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authQueryKey, useDeleteGpStationConnection, useSaveGpStationConnection } from './use-auth'

const api = vi.hoisted(() => ({
  deleteGpStationConnection: vi.fn(),
  fetchMe: vi.fn(),
  logout: vi.fn(),
  saveGpStationConnection: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    User: {
      deleteGpStationConnection: api.deleteGpStationConnection,
      fetchMe: api.fetchMe,
      saveGpStationConnection: api.saveGpStationConnection,
    },
  },
  logout: api.logout,
}))

const baseUser = {
  id: 'user-1',
  email: 'designer@example.com',
  display_name: 'Designer',
  picture_url: null,
  is_active: true,
  roles: ['user'],
  created_at: '2026-07-21T00:00:00Z',
  updated_at: '2026-07-21T00:00:00Z',
  gpstation_connection: null,
}

describe('GPStation auth cache mutations', () => {
  beforeEach(() => {
    api.saveGpStationConnection.mockReset()
    api.deleteGpStationConnection.mockReset()
  })

  it('replaces the auth user cache after save and delete', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(authQueryKey, baseUser)
    const connection = {
      api_base_url: 'https://gps.example.test',
      access_token: 'gpsk_secret',
    }
    const connectedUser = { ...baseUser, gpstation_connection: connection }
    api.saveGpStationConnection.mockResolvedValue(connectedUser)
    api.deleteGpStationConnection.mockResolvedValue(baseUser)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const save = renderHook(() => useSaveGpStationConnection(), { wrapper })
    const remove = renderHook(() => useDeleteGpStationConnection(), { wrapper })

    await act(async () => {
      await save.result.current.mutateAsync(connection)
    })
    expect(queryClient.getQueryData(authQueryKey)).toEqual(connectedUser)

    await act(async () => {
      await remove.result.current.mutateAsync()
    })
    expect(queryClient.getQueryData(authQueryKey)).toEqual(baseUser)
  })
})
