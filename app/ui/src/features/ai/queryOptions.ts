import { queryOptions } from '@tanstack/react-query'
import { aiAgentApi } from '@/api/aiAgent'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { aiQueryKeys } from './queryKeys'

export function aiProvidersQueryOptions(scope: PrivateQueryScope, enabled: boolean) {
  return queryOptions({
    queryKey: aiQueryKeys.providers(scope),
    queryFn: ({ signal }) => aiAgentApi.listProviders({ signal }),
    enabled,
    staleTime: 30_000,
  })
}
