import { dbTables, getListRequest } from '@/api'
import { deserializeCadScene, type EvaluatedDocumentSnapshot } from '@/lib/cad'
import {
  readFrozenMaterialParameters,
  resolveMaterialParameters,
  sourceOnlyMaterialParameters,
  type MaterialResolution,
} from '@/lib/material'

export function createDocumentMaterialResolver(storedSnapshot: unknown | null) {
  const materialNameQueries = new Map<string, ReturnType<typeof dbTables.MaterialName.listRows>>()
  const materialQueries = new Map<string, ReturnType<typeof dbTables.Material.listRows>>()
  const parameterQueries = new Map<string, ReturnType<typeof dbTables.MaterialParameter.listRows>>()

  return async (snapshot: EvaluatedDocumentSnapshot): Promise<MaterialResolution> => {
    const scene = deserializeCadScene(snapshot.scene)
    const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))

    if (storedSnapshot !== null) {
      if (
        typeof storedSnapshot === 'object' &&
        !Array.isArray(storedSnapshot) &&
        Object.keys(storedSnapshot).length === 0
      ) {
        return sourceOnlyMaterialParameters(materials)
      }
      const frozen = readFrozenMaterialParameters(storedSnapshot)
      if (!frozen) {
        throw new Error(
          `저장된 ${snapshot.kind === 'structure' ? 'Sample' : 'Setup'} Material snapshot이 올바르지 않습니다.`,
        )
      }
      return Object.freeze({ materialParameters: frozen, warnings: Object.freeze([]) })
    }

    const materialNames = [...new Set(materials.map((material) => material.name))].sort()
    if (materialNames.length === 0) return resolveMaterialParameters([], [], [])

    const materialNameKey = JSON.stringify(materialNames)
    let materialNameQuery = materialNameQueries.get(materialNameKey)
    if (!materialNameQuery) {
      materialNameQuery = dbTables.MaterialName.listRows({
        ...getListRequest('visible'),
        limit: null,
        filter: { name: materialNames },
      })
      materialNameQueries.set(materialNameKey, materialNameQuery)
      void materialNameQuery.catch(() => {
        if (materialNameQueries.get(materialNameKey) === materialNameQuery) {
          materialNameQueries.delete(materialNameKey)
        }
      })
    }
    const names = (await materialNameQuery).items
    const materialIds = [...new Set(names.map((row) => row.material_id))].sort((left, right) => left - right)
    if (materialIds.length === 0) return resolveMaterialParameters(materials, names, [], { seed: snapshot.seed })

    const materialIdKey = JSON.stringify(materialIds)
    let materialQuery = materialQueries.get(materialIdKey)
    if (!materialQuery) {
      materialQuery = dbTables.Material.listRows({
        ...getListRequest('visible'),
        limit: null,
        filter: { id: materialIds },
      })
      materialQueries.set(materialIdKey, materialQuery)
      void materialQuery.catch(() => {
        if (materialQueries.get(materialIdKey) === materialQuery) materialQueries.delete(materialIdKey)
      })
    }
    let parameterQuery = parameterQueries.get(materialIdKey)
    if (!parameterQuery) {
      parameterQuery = dbTables.MaterialParameter.listRows({
        ...getListRequest('visible'),
        limit: null,
        filter: { material_id: materialIds },
      })
      parameterQueries.set(materialIdKey, parameterQuery)
      void parameterQuery.catch(() => {
        if (parameterQueries.get(materialIdKey) === parameterQuery) parameterQueries.delete(materialIdKey)
      })
    }
    const [databaseMaterials, parameters] = await Promise.all([materialQuery, parameterQuery])
    return resolveMaterialParameters(materials, names, parameters.items, {
      materials: databaseMaterials.items,
      seed: snapshot.seed,
    })
  }
}

export function resolveDocumentMaterials(
  snapshot: EvaluatedDocumentSnapshot,
  storedSnapshot: unknown | null,
): Promise<MaterialResolution> {
  return createDocumentMaterialResolver(storedSnapshot)(snapshot)
}
