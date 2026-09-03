import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const experimentQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'experiments'] as const,
  available: (scope: PrivateQueryScope) => [...experimentQueryKeys.all(scope), 'available'] as const,
  detail: (scope: PrivateQueryScope, experimentId: number) =>
    [...experimentQueryKeys.all(scope), 'detail', experimentId] as const,
  records: (scope: PrivateQueryScope, experimentId: number | null) =>
    [...experimentQueryKeys.all(scope), 'records', experimentId] as const,
  adminExperiments: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'admin', 'experiments'] as const,
  adminDemoCandidates: (scope: PrivateQueryScope) =>
    [...privateQueryKeys.scope(scope), 'admin', 'demo-experiment-candidates'] as const,
}
