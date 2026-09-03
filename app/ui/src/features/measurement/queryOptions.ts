import { queryOptions } from '@tanstack/react-query'
import { dbTables, getListRequest, type GetListRequest } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { measurementQueryKeys } from './queryKeys'

export function measurementsQueryOptions(
  scope: PrivateQueryScope,
  experimentId: number | null,
  request: GetListRequest,
) {
  return queryOptions({
    queryKey: measurementQueryKeys.list(scope, experimentId, request),
    queryFn: ({ signal }) => dbTables.Measurement.listRows(request, { signal }),
  })
}

export function measurementDetailQueryOptions(
  scope: PrivateQueryScope,
  measurementId: number,
  listScope: 'mine' | 'visible' = 'visible',
) {
  return queryOptions({
    queryKey: measurementQueryKeys.detail(scope, listScope, measurementId),
    queryFn: async ({ signal }) => {
      const row = (await dbTables.Measurement.listRows(getListRequest(listScope, [measurementId]), { signal })).items[0]
      if (!row?.id) throw new Error(`Measurement #${measurementId}을 찾을 수 없습니다.`)
      return row
    },
    staleTime: 30_000,
  })
}

export function measurementRecordedDataQueryOptions(scope: PrivateQueryScope, measurementId: number) {
  return queryOptions({
    queryKey: measurementQueryKeys.recordedData(scope, measurementId),
    queryFn: ({ signal }) => dbTables.Measurement.readRecordedData(measurementId, { signal }),
    staleTime: 30_000,
  })
}
