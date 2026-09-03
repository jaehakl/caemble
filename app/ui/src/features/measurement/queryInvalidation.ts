import type { QueryClient } from '@tanstack/react-query'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { calculationDataQueryKeys } from '@/features/calculation/queryKeys'
import { invalidateExperimentSummaries } from '@/features/experiment/queryInvalidation'
import { measurementQueryKeys } from './queryKeys'

export function invalidateMeasurementMutation(
  queryClient: QueryClient,
  scope: PrivateQueryScope,
  experimentId: number | null,
  measurementIds: readonly number[] = [],
) {
  const measurementListKey =
    experimentId === null ? measurementQueryKeys.all(scope) : measurementQueryKeys.lists(scope, experimentId)
  const calculationDataKey =
    experimentId === null
      ? calculationDataQueryKeys.all(scope)
      : calculationDataQueryKeys.forExperiment(scope, experimentId)
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: measurementListKey }),
    queryClient.invalidateQueries({ queryKey: calculationDataKey }),
    ...measurementIds.flatMap((measurementId) => [
      queryClient.invalidateQueries({ queryKey: measurementQueryKeys.detail(scope, 'mine', measurementId) }),
      queryClient.invalidateQueries({ queryKey: measurementQueryKeys.detail(scope, 'visible', measurementId) }),
      queryClient.invalidateQueries({ queryKey: measurementQueryKeys.recordedData(scope, measurementId) }),
    ]),
    invalidateExperimentSummaries(queryClient, scope, experimentId),
  ])
}
