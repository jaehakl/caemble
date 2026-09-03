import type { QueryClient } from '@tanstack/react-query'
import { privateCacheQueryRoots, privateQueryKeys, type PrivateQueryScope } from './queryKeys'

export function clearPrivateQueryScope(queryClient: QueryClient, scope: PrivateQueryScope) {
  if (scope !== 'public') queryClient.removeQueries({ queryKey: privateQueryKeys.scope(scope) })
}

export function clearPrivateQueryCache(queryClient: QueryClient) {
  privateCacheQueryRoots.forEach((queryKey) => queryClient.removeQueries({ queryKey }))
}
