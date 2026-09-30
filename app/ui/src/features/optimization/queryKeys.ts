import { privateQueryKeys, type PrivateQueryScope } from '@/features/auth/queryKeys'

export const optimizationQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'optimization'] as const,
  lists: (scope: PrivateQueryScope) => [...optimizationQueryKeys.all(scope), 'list'] as const,
  list: (scope: PrivateQueryScope, experimentId: number | undefined, offset: number) =>
    [...optimizationQueryKeys.lists(scope), experimentId, offset] as const,
  detail: (scope: PrivateQueryScope, id: string | null) => [...optimizationQueryKeys.all(scope), 'detail', id] as const,
  trials: (scope: PrivateQueryScope, id: string | null, offset: number) =>
    [...optimizationQueryKeys.all(scope), 'trials', id, offset] as const,
}
