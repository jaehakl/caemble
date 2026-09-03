import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
import { catalogApi, catalogQueryKeys, type CatalogExperimentIdentity } from '@/api/catalog'
import { ApiError } from '@/api/http'
import type { ListQuery } from '@/contracts/catalog'

export function catalogMetaQueryOptions() {
  return queryOptions({
    queryKey: catalogQueryKeys.meta,
    queryFn: ({ signal }) => catalogApi.meta({ signal }),
  })
}

export function catalogQuantityKindsQueryOptions(query: ListQuery, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.quantityKindsList(query),
    queryFn: ({ signal }) => catalogApi.listQuantityKinds(query, { signal }),
    enabled,
  })
}

export function catalogQuantityKindsInfiniteQueryOptions(query: ListQuery) {
  return infiniteQueryOptions({
    queryKey: catalogQueryKeys.quantityKindsInfinite(query),
    queryFn: ({ pageParam, signal }) => catalogApi.listQuantityKinds({ ...query, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}

export function catalogQuantityKindQueryOptions(name: string, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.quantityKind(name),
    queryFn: ({ signal }) => catalogApi.getQuantityKind(name, { signal }),
    enabled,
  })
}

export function catalogMaterialParametersQueryOptions(query: ListQuery, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.materialParametersList(query),
    queryFn: ({ signal }) => catalogApi.listMaterialParameters(query, { signal }),
    enabled,
  })
}

export function catalogMaterialParametersInfiniteQueryOptions(query: ListQuery) {
  return infiniteQueryOptions({
    queryKey: catalogQueryKeys.materialParametersInfinite(query),
    queryFn: ({ pageParam, signal }) => catalogApi.listMaterialParameters({ ...query, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}

export function catalogMaterialParameterQueryOptions(key: string, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.materialParameter(key),
    queryFn: ({ signal }) => catalogApi.getMaterialParameter(key, { signal }),
    enabled,
  })
}

export function catalogMaterialModelsQueryOptions(query: ListQuery, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.materialModels(query),
    queryFn: ({ signal }) => catalogApi.listMaterialModels(query, { signal }),
    enabled,
  })
}

export function catalogMaterialModelQueryOptions(key: string, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.materialModel(key),
    queryFn: ({ signal }) => catalogApi.getMaterialModel(key, { signal }),
    enabled,
  })
}

export function catalogSolversQueryOptions(query: ListQuery, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.solvers(query),
    queryFn: ({ signal }) => catalogApi.listSolvers(query, { signal }),
    enabled,
  })
}

export function catalogSolverQueryOptions(name: string, version: string, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.solver(name, version),
    queryFn: ({ signal }) => catalogApi.getSolver(name, version, { signal }),
    enabled,
  })
}

export function catalogExperimentsQueryOptions(query: ListQuery, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.experiments(query),
    queryFn: ({ signal }) => catalogApi.listExperiments(query, { signal }),
    enabled,
  })
}

export function catalogExperimentQueryOptions(identity: string | CatalogExperimentIdentity, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.experiment(identity),
    queryFn: ({ signal }) => catalogApi.getExperiment(identity, { signal }),
    enabled,
  })
}

export function catalogSearchQueryOptions(query: string, limit = 50, enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.search(query, limit),
    queryFn: ({ signal }) => catalogApi.search(query, limit, { signal }),
    enabled,
    retry: false,
    staleTime: 30_000,
  })
}

export function materialManagerRuntimeQueryOptions(parameterNames: readonly string[], enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.materialManagerRuntime(parameterNames),
    queryFn: async ({ signal }) => {
      const materialParameters: string[] = []
      const materialModels: string[] = []
      for (const name of parameterNames) {
        try {
          if (name.startsWith('model.')) {
            await catalogApi.getMaterialModel(name, { signal })
            materialModels.push(name)
          } else {
            await catalogApi.getMaterialParameter(name, { signal })
            materialParameters.push(name)
          }
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404) throw error
        }
      }
      return catalogApi.runtimeSlice(
        {
          solvers: [],
          quantityKinds: [],
          materialParameters,
          materialModels,
        },
        { signal },
      )
    },
    enabled,
  })
}

export function recordedDataRuntimeQueryOptions(quantityKindNames: readonly string[], enabled = true) {
  return queryOptions({
    queryKey: catalogQueryKeys.recordedDataRuntime(quantityKindNames),
    queryFn: ({ signal }) =>
      catalogApi.runtimeSlice(
        {
          solvers: [],
          quantityKinds: quantityKindNames,
          materialParameters: [],
          materialModels: [],
        },
        { signal },
      ),
    enabled,
  })
}
