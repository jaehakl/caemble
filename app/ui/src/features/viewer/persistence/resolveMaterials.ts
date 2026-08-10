import { dbTables, getListRequest } from '@/api'
import { deserializeCadScene, type EvaluatedDocumentSnapshot, type TaskMaterialResolution } from '@/lib/cad'
import {
  readFrozenMaterialParameters,
  resolveMaterialParameters,
  sourceOnlyMaterialParameters,
  type FrozenMaterialParameters,
  type MaterialResolution,
} from '@/lib/material'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStoredTaskMaterials(value: unknown, taskNames: readonly string[]) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.tasks)) return null
  const tasks = value.tasks
  if (
    Object.keys(tasks).length !== taskNames.length ||
    taskNames.some((name) => !readFrozenMaterialParameters(tasks[name]))
  ) {
    return null
  }
  return tasks as Readonly<Record<string, FrozenMaterialParameters>>
}

export function createDocumentMaterialResolver(storedSnapshot: unknown | null) {
  const materialNameQueries = new Map<string, ReturnType<typeof dbTables.MaterialName.listRows>>()
  const materialQueries = new Map<string, ReturnType<typeof dbTables.Material.listRows>>()
  const parameterQueries = new Map<string, ReturnType<typeof dbTables.MaterialParameter.listRows>>()

  const resolveOne = async (
    materials: Parameters<typeof resolveMaterialParameters>[0],
    seed: number,
    frozen: FrozenMaterialParameters | null,
  ): Promise<MaterialResolution> => {
    if (frozen) return Object.freeze({ materialParameters: frozen, warnings: Object.freeze([]) })
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
        if (materialNameQueries.get(materialNameKey) === materialNameQuery) materialNameQueries.delete(materialNameKey)
      })
    }
    const names = (await materialNameQuery).items
    const materialIds = [...new Set(names.map((row) => row.material_id))].sort((left, right) => left - right)
    if (materialIds.length === 0) return resolveMaterialParameters(materials, names, [], { seed })

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
      seed,
    })
  }

  return async (snapshot: EvaluatedDocumentSnapshot): Promise<MaterialResolution | TaskMaterialResolution> => {
    const storedIsEmpty = isRecord(storedSnapshot) && Object.keys(storedSnapshot).length === 0
    if (snapshot.kind === 'structure') {
      const scene = deserializeCadScene(snapshot.scene)
      const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
      if (storedSnapshot !== null && !storedIsEmpty) {
        const frozen = readFrozenMaterialParameters(storedSnapshot)
        if (!frozen) throw new Error('저장된 Sample Material snapshot이 올바르지 않습니다.')
        return resolveOne(materials, snapshot.seed, frozen)
      }
      return storedIsEmpty ? sourceOnlyMaterialParameters(materials) : resolveOne(materials, snapshot.seed, null)
    }

    const taskNames = Object.keys(snapshot.taskScenes).sort()
    let storedTasks: Readonly<Record<string, FrozenMaterialParameters>> | null = null
    if (storedSnapshot !== null && !storedIsEmpty) {
      storedTasks = readStoredTaskMaterials(storedSnapshot, taskNames)
      if (!storedTasks) throw new Error('저장된 Setup Task Material snapshot이 올바르지 않습니다.')
    }
    const entries = await Promise.all(
      taskNames.map(async (name) => {
        const scene = deserializeCadScene(snapshot.taskScenes[name])
        const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
        const resolution = storedIsEmpty
          ? sourceOnlyMaterialParameters(materials)
          : await resolveOne(materials, snapshot.seed, storedTasks?.[name] ?? null)
        return [name, resolution] as const
      }),
    )
    return Object.freeze({
      taskMaterialParameters: Object.freeze(
        Object.fromEntries(entries.map(([name, resolution]) => [name, resolution.materialParameters])),
      ),
      taskMaterialWarnings: Object.freeze(
        Object.fromEntries(entries.map(([name, resolution]) => [name, Object.freeze([...resolution.warnings])])),
      ),
    })
  }
}

export function resolveDocumentMaterials(snapshot: EvaluatedDocumentSnapshot, storedSnapshot: unknown | null) {
  return createDocumentMaterialResolver(storedSnapshot)(snapshot)
}
