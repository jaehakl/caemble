import type { QueryClient } from '@tanstack/react-query'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { materialQueryKeys } from './queryKeys'

export function invalidateMaterialQueries(queryClient: QueryClient, scope: PrivateQueryScope) {
  return queryClient.invalidateQueries({ queryKey: materialQueryKeys.all(scope) })
}
