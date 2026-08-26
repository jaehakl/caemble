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
import { request } from './http'

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
  quantityKinds: (query: ListQuery) => ['catalog', 'quantity-kinds', query] as const,
  quantityKind: (name: string) => ['catalog', 'quantity-kind', name] as const,
  materialParameters: (query: ListQuery) => ['catalog', 'material-parameters', query] as const,
  materialParameter: (key: string) => ['catalog', 'material-parameter', key] as const,
  materialModels: (query: ListQuery) => ['catalog', 'material-models', query] as const,
  solvers: (query: ListQuery) => ['catalog', 'solvers', query] as const,
  solver: (name: string, version: string) => ['catalog', 'solver', name, version] as const,
  experiments: (query: ListQuery) => ['catalog', 'experiments', query] as const,
  experiment: (identity: string | CatalogExperimentIdentity) =>
    ['catalog', 'experiment', typeof identity === 'string' ? identity : identity.coordinate] as const,
  search: (query: string) => ['catalog', 'search', query] as const,
} as const

export const catalogApi = {
  meta: () => request<CatalogMeta>('get', catalogUrl('/meta')),
  listQuantityKinds: (query: ListQuery = {}) =>
    request<CatalogList<CatalogQuantityKind>>('get', catalogUrl('/quantity-kinds', query)),
  getQuantityKind: (name: string) =>
    request<CatalogQuantityKindDetail>('get', catalogUrl(`/quantity-kinds/${encodeURIComponent(name)}`)),
  listMaterialParameters: (query: ListQuery = {}) =>
    request<CatalogList<CatalogMaterialParameter>>('get', catalogUrl('/material-parameters', query)),
  getMaterialParameter: (key: string) =>
    request<CatalogMaterialParameterDetail>('get', catalogUrl(`/material-parameters/${encodeURIComponent(key)}`)),
  listMaterialModels: (query: ListQuery = {}) =>
    request<CatalogList<CatalogMaterialModel>>('get', catalogUrl('/material-models', query)),
  getMaterialModel: (key: string) =>
    request<CatalogMaterialModel>('get', catalogUrl(`/material-models/${encodeURIComponent(key)}`)),
  listSolvers: (query: ListQuery = {}) =>
    request<CatalogList<CatalogSolverListItem>>('get', catalogUrl('/solvers', query)),
  getSolver: (name: string, version: string) =>
    request<CatalogSolverDetail>(
      'get',
      catalogUrl(`/solvers/${encodeURIComponent(name)}/${encodeURIComponent(version)}`),
    ),
  listExperiments: (query: ListQuery = {}) =>
    request<CatalogList<CatalogExperimentListItem>>('get', catalogUrl('/experiments', query)),
  async getExperiment(identity: string | CatalogExperimentIdentity) {
    const parsed = typeof identity === 'string' && identity.startsWith('caemble:experiment/')
      ? identity.slice('caemble:experiment/'.length).split('/')
      : null
    const coordinateTail = parsed?.[parsed.length - 1]?.split('@')
    const key = typeof identity === 'string' ? (coordinateTail?.[0] ?? identity) : identity.key
    const query = typeof identity === 'string'
      ? parsed && coordinateTail
        ? { namespace: parsed[0], repository: parsed[1], version: coordinateTail[1] }
        : {}
      : { namespace: identity.namespace, repository: identity.repository, version: identity.version }
    return request<CatalogExperimentDetail>('get', catalogUrl(`/experiments/${encodeURIComponent(key)}`, query))
  },
  search: async (q: string, limit = 50) =>
    (await request<Readonly<{ items: readonly CatalogSearchItem[] }>>('get', catalogUrl('/search', { q, limit }))).items,
  runtimeSlice: (payload: CatalogRuntimeSliceRequest) =>
    request<CatalogRuntimeSlice>('post', catalogUrl('/runtime-slice'), payload),
} as const
