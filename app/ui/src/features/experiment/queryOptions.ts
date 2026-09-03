import { queryOptions } from '@tanstack/react-query'
import { dbTables, getListRequest } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { experimentQueryKeys } from './queryKeys'

export function availableExperimentsQueryOptions(scope: PrivateQueryScope) {
  return queryOptions({
    queryKey: experimentQueryKeys.available(scope),
    queryFn: async ({ signal }) => {
      const available = await dbTables.Experiment.available({ signal })
      return scope === 'public' ? { mine: [], demos: available.demos } : available
    },
  })
}

export function experimentDetailQueryOptions(scope: PrivateQueryScope, experimentId: number) {
  return queryOptions({
    queryKey: experimentQueryKeys.detail(scope, experimentId),
    queryFn: async ({ signal }) => {
      const row = (await dbTables.Experiment.listRows(getListRequest('visible', [experimentId]), { signal })).items[0]
      if (!row) throw new Error(`Experiment #${experimentId}을 찾을 수 없습니다.`)
      return row
    },
    staleTime: 0,
  })
}

export function experimentRecordsQueryOptions(scope: PrivateQueryScope, experimentId: number | null) {
  return queryOptions({
    queryKey: experimentQueryKeys.records(scope, experimentId),
    queryFn: ({ signal }) => {
      if (experimentId === null) throw new Error('Experiment가 선택되지 않았습니다.')
      return dbTables.ExperimentRecord.listRows(
        {
          ...getListRequest('visible'),
          experiment_id: experimentId,
          filter: { experiment_id: [experimentId, experimentId] },
          limit: null,
          sort: ['name', 'asc'],
        },
        { signal },
      )
    },
  })
}

export function adminExperimentsQueryOptions(scope: PrivateQueryScope) {
  return queryOptions({
    queryKey: experimentQueryKeys.adminExperiments(scope),
    queryFn: ({ signal }) =>
      dbTables.Experiment.listRows(
        {
          ...getListRequest('visible'),
          limit: null,
          sort: ['updated_at', 'desc'],
        },
        { signal },
      ),
  })
}

export function adminDemoCandidatesQueryOptions(scope: PrivateQueryScope) {
  return queryOptions({
    queryKey: experimentQueryKeys.adminDemoCandidates(scope),
    queryFn: ({ signal }) => dbTables.Experiment.demoCandidates({ signal }),
  })
}
