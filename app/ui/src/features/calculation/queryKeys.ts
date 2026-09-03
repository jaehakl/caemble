import type { GetListRequest } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { privateQueryKeys } from '@/features/auth/queryKeys'

export const calculationQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'calculations'] as const,
  lists: (scope: PrivateQueryScope, experimentId: number | null) =>
    [...calculationQueryKeys.all(scope), 'list', experimentId] as const,
  list: (scope: PrivateQueryScope, experimentId: number | null, request: GetListRequest) =>
    [...calculationQueryKeys.lists(scope, experimentId), request] as const,
}

export const calculationDataQueryKeys = {
  all: (scope: PrivateQueryScope) => [...privateQueryKeys.scope(scope), 'calculation-data'] as const,
  forExperiment: (scope: PrivateQueryScope, experimentId: number | null) =>
    [...calculationDataQueryKeys.all(scope), 'experiment', experimentId] as const,
  scalars: (
    scope: PrivateQueryScope,
    experimentId: number | null,
    calculationId: number | null,
    excludedMeasurementId: number | null,
  ) =>
    [
      ...calculationDataQueryKeys.forExperiment(scope, experimentId),
      'scalars',
      calculationId,
      excludedMeasurementId,
    ] as const,
}
