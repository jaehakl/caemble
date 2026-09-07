import { createDbTables, getListRequest } from './api'
import type { CaembleClient } from './http'

export async function fetchBuildMaterials(client: CaembleClient, signal?: AbortSignal) {
  const tables = createDbTables(client)
  const request = { ...getListRequest(), limit: null }
  const [names, materials, parameters, qualifiers] = await Promise.all([
    tables.MaterialName.listRows(request, { signal }),
    tables.Material.listRows(request, { signal }),
    tables.MaterialParameter.listRows(request, { signal }),
    tables.MaterialParameterQualifier.listRows(request, { signal }),
  ])
  return { names: names.items, materials: materials.items, parameters: parameters.items, qualifiers: qualifiers.items }
}
