import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dbTables, logout } from '@/api'

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
