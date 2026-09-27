import type { QueryClient } from '@tanstack/react-query'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { invalidateExperimentSummaries } from '@/features/experiment/queryInvalidation'
import { measurementQueryKeys } from '@/features/measurement/queryKeys'
import { calculationDataQueryKeys, calculationQueryKeys } from './queryKeys'

export function invalidateCalculationMutation(
  queryClient: QueryClient,
  scope: PrivateQueryScope,
  experimentId: number | null,
) {
  void experimentId
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: calculationQueryKeys.all(scope) }),
    queryClient.invalidateQueries({ queryKey: calculationDataQueryKeys.all(scope) }),
    queryClient.invalidateQueries({ queryKey: measurementQueryKeys.all(scope) }),
    queryClient.invalidateQueries({ queryKey: ['calculation-library', scope] }),
    invalidateExperimentSummaries(queryClient, scope, null),
  ])
}

export function invalidateCalculationDataMutation(
  queryClient: QueryClient,
  scope: PrivateQueryScope,
  experimentId: number | null,
) {
  const calculationDataKey =
    experimentId === null
      ? calculationDataQueryKeys.all(scope)
      : calculationDataQueryKeys.forExperiment(scope, experimentId)
  const measurementListKey =
    experimentId === null ? measurementQueryKeys.all(scope) : measurementQueryKeys.lists(scope, experimentId)
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey:
        experimentId === null ? calculationQueryKeys.all(scope) : calculationQueryKeys.lists(scope, experimentId),
    }),
    queryClient.invalidateQueries({ queryKey: calculationDataKey }),
    queryClient.invalidateQueries({ queryKey: measurementListKey }),
    invalidateExperimentSummaries(queryClient, scope, experimentId),
  ])
}
