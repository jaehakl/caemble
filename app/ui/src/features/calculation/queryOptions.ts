import { queryOptions } from '@tanstack/react-query'
import { dbTables, type GetListRequest } from '@/api'
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
