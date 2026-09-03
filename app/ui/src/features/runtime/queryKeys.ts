import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const runtimeQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'runtime'] as const,
  accessKeys: (scope: PrivateQueryScope) => [...runtimeQueryKeys.all(scope), 'access-keys'] as const,
  jobsAll: (scope: PrivateQueryScope) => [...runtimeQueryKeys.all(scope), 'jobs'] as const,
  jobs: (scope: PrivateQueryScope, activeOnly: boolean) =>
    [...runtimeQueryKeys.jobsAll(scope), { activeOnly }] as const,
  launchers: (scope: PrivateQueryScope) => [...runtimeQueryKeys.all(scope), 'launchers'] as const,
}
