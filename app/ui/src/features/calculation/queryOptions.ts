import { queryOptions } from '@tanstack/react-query'
import { dbTables, getListRequest, type GetListRequest } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { calculationDataQueryKeys, calculationQueryKeys } from './queryKeys'

export function calculationsQueryOptions(
  scope: PrivateQueryScope,
  experimentId: number | null,
  request: GetListRequest,
) {
  return queryOptions({
    queryKey: calculationQueryKeys.list(scope, experimentId, request),
    queryFn: ({ signal }) => dbTables.Calculation.listRows(request, { signal }),
  })
}

export function calculationDetailQueryOptions(scope: PrivateQueryScope, experimentId: number, calculationId: number) {
  return queryOptions({
    queryKey: calculationQueryKeys.detail(scope, experimentId, calculationId),
    queryFn: async ({ signal }) => {
      const request = {
        ...getListRequest('visible', [calculationId]),
        limit: 1,
        filter: { experiment_id: [experimentId, experimentId] as const },
      }
      const row = (await dbTables.Calculation.listRows(request, { signal })).items[0]
      if (!row?.id || row.experiment_id !== experimentId) {
        throw new Error(`Calculation #${calculationId}을 현재 Experiment에서 찾을 수 없습니다.`)
      }
      return row
    },
    staleTime: 30_000,
  })
}

export function calculationScalarsQueryOptions(
  scope: PrivateQueryScope,
  experimentId: number | null,
  calculationId: number | null,
  excludedMeasurementId: number | null,
) {
  return queryOptions({
    queryKey: calculationDataQueryKeys.scalars(scope, experimentId, calculationId, excludedMeasurementId),
    queryFn: ({ signal }) => {
      if (calculationId === null) throw new Error('Scalar Calculation이 선택되지 않았습니다.')
      return dbTables.CalculationData.scalars(
        {
          calculation_id: calculationId,
          ...(excludedMeasurementId === null ? {} : { exclude_measurement_id: excludedMeasurementId }),
        },
        { signal },
      )
    },
  })
}
