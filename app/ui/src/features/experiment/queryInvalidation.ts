import type { QueryClient } from '@tanstack/react-query'
import { authQueryKey, type PrivateQueryScope } from '@/features/auth/queryKeys'
import { calculationDataQueryKeys, calculationQueryKeys } from '@/features/calculation/queryKeys'
import { measurementQueryKeys } from '@/features/measurement/queryKeys'
import { experimentQueryKeys } from './queryKeys'

export function invalidateExperimentSummaries(
  queryClient: QueryClient,
  scope: PrivateQueryScope,
  experimentId?: number | null,
) {
  const invalidations = [
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.available(scope) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.adminExperiments(scope) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.adminDemoCandidates(scope) }),
  ]
  if (experimentId != null) {
    invalidations.push(queryClient.invalidateQueries({ queryKey: experimentQueryKeys.detail(scope, experimentId) }))
  }
  return Promise.all(invalidations)
}

export function invalidateExperimentMutation(queryClient: QueryClient, scope: PrivateQueryScope, experimentId: number) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.available(scope) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.detail(scope, experimentId) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.records(scope, experimentId) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.adminExperiments(scope) }),
    queryClient.invalidateQueries({ queryKey: experimentQueryKeys.adminDemoCandidates(scope) }),
    queryClient.invalidateQueries({ queryKey: measurementQueryKeys.lists(scope, experimentId) }),
    queryClient.invalidateQueries({ queryKey: calculationQueryKeys.lists(scope, experimentId) }),
    queryClient.invalidateQueries({ queryKey: calculationDataQueryKeys.forExperiment(scope, experimentId) }),
    queryClient.invalidateQueries({ queryKey: authQueryKey }),
  ])
}
