import type {
  CatalogExperimentDetail,
  CatalogExperimentListItem,
  CatalogList,
  CatalogMaterialModel,
  CatalogMaterialParameter,
  CatalogMaterialParameterDetail,
  CatalogMeta,
  CatalogQuantityKind,
  CatalogQuantityKindDetail,
  CatalogRuntimeSlice,
  CatalogRuntimeSliceRequest,
  CatalogSearchItem,
  CatalogSolverDetail,
  CatalogSolverListItem,
  ListQuery,
} from '@/contracts/catalog'
import {
  parseCatalogExperimentDetail,
  parseCatalogExperimentList,
  parseCatalogMaterialModel,
  parseCatalogMaterialModelList,
  parseCatalogMaterialParameterDetail,
  parseCatalogMaterialParameterList,
  parseCatalogMeta,
  parseCatalogQuantityKindDetail,
  parseCatalogQuantityKindList,
  parseCatalogRuntimeSlice,
  parseCatalogSearchResponse,
  parseCatalogSolverDetail,
  parseCatalogSolverList,
} from '@/contracts/catalogValidators'
import { request, type RequestContext } from './http'

export type CatalogExperimentIdentity = Readonly<{
  key: string
  namespace: string
  repository: string
  version: string
  coordinate: string
}>

function catalogUrl(path: string, query: ListQuery = {}) {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value))
  })
  const encoded = params.toString()
  return `/catalog${path}${encoded ? `?${encoded}` : ''}`
}

export type {
  CatalogMaterialModel,
  CatalogMaterialParameter,
  CatalogMaterialParameterDetail,
  CatalogMeta,
  CatalogExperimentDetail,
  CatalogExperimentListItem,
  CatalogQuantityKind,
  CatalogQuantityKindDetail,
  CatalogRuntimeSlice,
  CatalogRuntimeSliceRequest,
  CatalogSearchItem,
  CatalogSolverDetail,
  CatalogSolverListItem,
} from '@/contracts/catalog'

export const catalogQueryKeys = {
  root: ['catalog'] as const,
  meta: ['catalog', 'meta'] as const,
  quantityKindsList: (query: ListQuery) => ['catalog', 'quantity-kinds', 'list', query] as const,
  quantityKindsInfinite: (query: ListQuery) => ['catalog', 'quantity-kinds', 'infinite', query] as const,
  quantityKind: (name: string) => ['catalog', 'quantity-kind', name] as const,
  materialParametersList: (query: ListQuery) => ['catalog', 'material-parameters', 'list', query] as const,
  materialParametersInfinite: (query: ListQuery) => ['catalog', 'material-parameters', 'infinite', query] as const,
  materialParameter: (key: string) => ['catalog', 'material-parameter', key] as const,
  materialModels: (query: ListQuery) => ['catalog', 'material-models', query] as const,
  materialModel: (key: string) => ['catalog', 'material-model', key] as const,
  materialManagerRuntime: (parameterNames: readonly string[]) =>
    ['catalog', 'material-manager-runtime', parameterNames] as const,
  recordedDataRuntime: (quantityKindNames: readonly string[]) =>
    ['catalog', 'recorded-data-runtime', quantityKindNames] as const,
  solvers: (query: ListQuery) => ['catalog', 'solvers', query] as const,
  solver: (name: string, version: string) => ['catalog', 'solver', name, version] as const,
  experiments: (query: ListQuery) => ['catalog', 'experiments', query] as const,
  experiment: (identity: string | CatalogExperimentIdentity) =>
    ['catalog', 'experiment', typeof identity === 'string' ? identity : identity.coordinate] as const,
  search: (query: string, limit: number) => ['catalog', 'search', query, limit] as const,
} as const

export const catalogApi = {
  meta: (context?: RequestContext) =>
    request<CatalogMeta>('get', catalogUrl('/meta'), undefined, {
      signal: context?.signal,
      validate: parseCatalogMeta,
    }),
  listQuantityKinds: (query: ListQuery = {}, context?: RequestContext) =>
    request<CatalogList<CatalogQuantityKind>>('get', catalogUrl('/quantity-kinds', query), undefined, {
      signal: context?.signal,
      validate: parseCatalogQuantityKindList,
    }),
  getQuantityKind: (name: string, context?: RequestContext) =>
    request<CatalogQuantityKindDetail>(
      'get',
      catalogUrl(`/quantity-kinds/${encodeURIComponent(name)}`),
      undefined,
      { signal: context?.signal, validate: parseCatalogQuantityKindDetail },
    ),
  listMaterialParameters: (query: ListQuery = {}, context?: RequestContext) =>
    request<CatalogList<CatalogMaterialParameter>>('get', catalogUrl('/material-parameters', query), undefined, {
      signal: context?.signal,
      validate: parseCatalogMaterialParameterList,
    }),
  getMaterialParameter: (key: string, context?: RequestContext) =>
    request<CatalogMaterialParameterDetail>(
      'get',
      catalogUrl(`/material-parameters/${encodeURIComponent(key)}`),
      undefined,
      { signal: context?.signal, validate: parseCatalogMaterialParameterDetail },
    ),
  listMaterialModels: (query: ListQuery = {}, context?: RequestContext) =>
    request<CatalogList<CatalogMaterialModel>>('get', catalogUrl('/material-models', query), undefined, {
      signal: context?.signal,
      validate: parseCatalogMaterialModelList,
    }),
  getMaterialModel: (key: string, context?: RequestContext) =>
    request<CatalogMaterialModel>(
      'get',
      catalogUrl(`/material-models/${encodeURIComponent(key)}`),
      undefined,
      { signal: context?.signal, validate: parseCatalogMaterialModel },
    ),
  listSolvers: (query: ListQuery = {}, context?: RequestContext) =>
    request<CatalogList<CatalogSolverListItem>>('get', catalogUrl('/solvers', query), undefined, {
      signal: context?.signal,
      validate: parseCatalogSolverList,
    }),
  getSolver: (name: string, version: string, context?: RequestContext) =>
    request<CatalogSolverDetail>(
      'get',
      catalogUrl(`/solvers/${encodeURIComponent(name)}/${encodeURIComponent(version)}`),
      undefined,
      { signal: context?.signal, validate: parseCatalogSolverDetail },
    ),
  listExperiments: (query: ListQuery = {}, context?: RequestContext) =>
    request<CatalogList<CatalogExperimentListItem>>('get', catalogUrl('/experiments', query), undefined, {
      signal: context?.signal,
      validate: parseCatalogExperimentList,
    }),
  async getExperiment(identity: string | CatalogExperimentIdentity, context?: RequestContext) {
    const parsed =
      typeof identity === 'string' && identity.startsWith('caemble:experiment/')
        ? identity.slice('caemble:experiment/'.length).split('/')
        : null
    const coordinateTail = parsed?.[parsed.length - 1]?.split('@')
    const key = typeof identity === 'string' ? (coordinateTail?.[0] ?? identity) : identity.key
    const query =
      typeof identity === 'string'
        ? parsed && coordinateTail
          ? { namespace: parsed[0], repository: parsed[1], version: coordinateTail[1] }
          : {}
        : { namespace: identity.namespace, repository: identity.repository, version: identity.version }
    return request<CatalogExperimentDetail>(
      'get',
      catalogUrl(`/experiments/${encodeURIComponent(key)}`, query),
      undefined,
      { signal: context?.signal, validate: parseCatalogExperimentDetail },
    )
  },
  search: async (q: string, limit = 50, context?: RequestContext) =>
    (
      await request<Readonly<{ items: readonly CatalogSearchItem[] }>>(
        'get',
        catalogUrl('/search', { q, limit }),
        undefined,
        { signal: context?.signal, validate: parseCatalogSearchResponse },
      )
    ).items,
  runtimeSlice: (payload: CatalogRuntimeSliceRequest, context?: RequestContext) =>
    request<CatalogRuntimeSlice>('post', catalogUrl('/runtime-slice'), payload, {
      signal: context?.signal,
      validate: parseCatalogRuntimeSlice,
    }),
} as const
