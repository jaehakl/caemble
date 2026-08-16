import { z } from 'zod'
import {
  catalogMetaSchema,
  listSchema,
  materialModelSchema,
  materialParameterDetailSchema,
  materialParameterSchema,
  quantityKindDetailSchema,
  quantityKindSchema,
  runtimeSliceSchema,
  searchItemSchema,
  solverDetailSchema,
  solverListItemSchema,
  type CatalogRuntimeSliceRequest,
  type ListQuery,
} from '@/contracts/catalog'
import { request } from './http'

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
  search: (query: string) => ['catalog', 'search', query] as const,
} as const

export const catalogApi = {
  async meta() {
    return catalogMetaSchema.parse(await request<unknown>('get', catalogUrl('/meta')))
  },
  async listQuantityKinds(query: ListQuery = {}) {
    return listSchema(quantityKindSchema).parse(await request<unknown>('get', catalogUrl('/quantity-kinds', query)))
  },
  async getQuantityKind(name: string) {
    return quantityKindDetailSchema.parse(
      await request<unknown>('get', catalogUrl(`/quantity-kinds/${encodeURIComponent(name)}`)),
    )
  },
  async listMaterialParameters(query: ListQuery = {}) {
    return listSchema(materialParameterSchema).parse(
      await request<unknown>('get', catalogUrl('/material-parameters', query)),
    )
  },
  async getMaterialParameter(key: string) {
    return materialParameterDetailSchema.parse(
      await request<unknown>('get', catalogUrl(`/material-parameters/${encodeURIComponent(key)}`)),
    )
  },
  async listMaterialModels(query: ListQuery = {}) {
    return listSchema(materialModelSchema).parse(await request<unknown>('get', catalogUrl('/material-models', query)))
  },
  async getMaterialModel(key: string) {
    return materialModelSchema.parse(
      await request<unknown>('get', catalogUrl(`/material-models/${encodeURIComponent(key)}`)),
    )
  },
  async listSolvers(query: ListQuery = {}) {
    return listSchema(solverListItemSchema).parse(await request<unknown>('get', catalogUrl('/solvers', query)))
  },
  async getSolver(name: string, version: string) {
    return solverDetailSchema.parse(
      await request<unknown>(
        'get',
        catalogUrl(`/solvers/${encodeURIComponent(name)}/${encodeURIComponent(version)}`),
      ),
    )
  },
  async search(q: string, limit = 50) {
    return z
      .object({ items: z.array(searchItemSchema) })
      .parse(await request<unknown>('get', catalogUrl('/search', { q, limit })))
  },
  async runtimeSlice(value: CatalogRuntimeSliceRequest) {
    const payload = z
      .object({
        solvers: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })).max(32),
        quantityKinds: z.array(z.string().min(1)).max(256),
        materialParameters: z.array(z.string().min(1)).max(256),
        materialModels: z.array(z.string().min(1)).max(64),
      })
      .parse(value)
    return runtimeSliceSchema.parse(await request<unknown>('post', catalogUrl('/runtime-slice'), payload))
  },
} as const
