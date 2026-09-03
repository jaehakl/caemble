import { queryOptions } from '@tanstack/react-query'
import { dbTables } from '@/api'
import type { PrivateQueryScope } from '@/features/auth/queryKeys'
import { allRowsRequest, relationRowsRequest } from './material-utils'
import { materialQueryKeys } from './queryKeys'

type MaterialVisibility = 'visible' | 'mine' | 'public'

export function materialsQueryOptions(scope: PrivateQueryScope, visibility: MaterialVisibility) {
  return queryOptions({
    queryKey: materialQueryKeys.list(scope, visibility),
    queryFn: ({ signal }) => dbTables.Material.listRows(allRowsRequest(visibility), { signal }),
  })
}

export function materialNamesListQueryOptions(scope: PrivateQueryScope, visibility: MaterialVisibility) {
  return queryOptions({
    queryKey: materialQueryKeys.namesList(scope, visibility),
    queryFn: ({ signal }) => dbTables.MaterialName.listRows(allRowsRequest(visibility), { signal }),
  })
}

export function materialDetailQueryOptions(scope: PrivateQueryScope, materialId: number, enabled = true) {
  return queryOptions({
    queryKey: materialQueryKeys.detail(scope, materialId),
    queryFn: async ({ signal }) => {
      const response = await dbTables.Material.listRows({ ...allRowsRequest(), selected_ids: [materialId] }, { signal })
      return response.items.find((entry) => entry.id === materialId) ?? null
    },
    enabled,
  })
}

export function materialNamesQueryOptions(scope: PrivateQueryScope, materialId: number, enabled = true) {
  return queryOptions({
    queryKey: materialQueryKeys.names(scope, materialId),
    queryFn: ({ signal }) => dbTables.MaterialName.listRows(relationRowsRequest('material_id', materialId), { signal }),
    enabled,
  })
}

export function materialParametersQueryOptions(scope: PrivateQueryScope, materialId: number, enabled = true) {
  return queryOptions({
    queryKey: materialQueryKeys.parameters(scope, materialId),
    queryFn: ({ signal }) =>
      dbTables.MaterialParameter.listRows(relationRowsRequest('material_id', materialId), { signal }),
    enabled,
  })
}

export function materialQualifiersQueryOptions(
  scope: PrivateQueryScope,
  materialId: number,
  parameterIds: readonly number[],
  enabled = true,
) {
  return queryOptions({
    queryKey: materialQueryKeys.qualifiers(scope, materialId, parameterIds),
    queryFn: async ({ signal }) => {
      const responses = await Promise.all(
        parameterIds.map((parameterId) =>
          dbTables.MaterialParameterQualifier.listRows(relationRowsRequest('material_parameter_id', parameterId), {
            signal,
          }),
        ),
      )
      return responses.flatMap((response) => response.items)
    },
    enabled,
  })
}
