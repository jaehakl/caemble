import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { logout } from '@/api'
import { clearPrivateQueryCache } from './queryCache'
import { authQueryOptions } from './queryOptions'
import { authQueryKey, privateQueryScope } from './queryKeys'

export { authQueryKey } from './queryKeys'

export function useAuth() {
  const query = useQuery(authQueryOptions)
  return {
    ...query,
    isAuthenticated: Boolean(query.data?.is_active),
    queryScope: privateQueryScope(query.data),
    user: query.data ?? null,
  }
}

export function usePrivateQueryScope() {
  return privateQueryScope(useQuery(authQueryOptions).data)
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.setQueryData(authQueryKey, null)
      clearPrivateQueryCache(queryClient)
    },
  })
}
