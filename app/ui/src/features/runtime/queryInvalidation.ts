import type { QueryClient } from '@tanstack/react-query'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { runtimeQueryKeys } from './queryKeys'

export function invalidateRuntimeJobs(queryClient: QueryClient, scope: PrivateQueryScope) {
  return queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.jobsAll(scope) })
}

export function invalidateLauncherMutation(queryClient: QueryClient, scope: PrivateQueryScope) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: runtimeQueryKeys.launchers(scope) }),
    invalidateRuntimeJobs(queryClient, scope),
  ])
}
