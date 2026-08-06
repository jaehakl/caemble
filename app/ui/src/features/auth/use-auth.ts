import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dbTables, logout } from '@/api'
import type { GPStationConnectionData } from '@/api'

export const authQueryKey = ['auth', 'me'] as const

export function useAuth() {
  const query = useQuery({
    queryKey: authQueryKey,
    queryFn: () => dbTables.User.fetchMe(),
    retry: false,
    staleTime: 60_000,
  })
  return {
    ...query,
    isAuthenticated: Boolean(query.data?.is_active),
    user: query.data ?? null,
  }
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(authQueryKey, null)
      queryClient.removeQueries({ queryKey: ['work'] })
    },
  })
}

export function useSaveGpStationConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (connection: GPStationConnectionData) => dbTables.User.saveGpStationConnection(connection),
    onSuccess: (user) => queryClient.setQueryData(authQueryKey, user),
  })
}

export function useDeleteGpStationConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => dbTables.User.deleteGpStationConnection(),
    onSuccess: (user) => queryClient.setQueryData(authQueryKey, user),
  })
}
