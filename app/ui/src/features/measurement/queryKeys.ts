import type { GetListRequest } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const measurementQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'measurements'] as const,
  lists: (scope: PrivateQueryScope, experimentId: number | null) =>
    [...measurementQueryKeys.all(scope), 'list', experimentId] as const,
  list: (scope: PrivateQueryScope, experimentId: number | null, request: GetListRequest) =>
    [...measurementQueryKeys.lists(scope, experimentId), request] as const,
  detail: (scope: PrivateQueryScope, listScope: 'mine' | 'visible', measurementId: number) =>
    [...measurementQueryKeys.all(scope), 'detail', listScope, measurementId] as const,
  recordedData: (scope: PrivateQueryScope, measurementId: number) =>
    [...measurementQueryKeys.all(scope), 'recorded-data', measurementId] as const,
}
