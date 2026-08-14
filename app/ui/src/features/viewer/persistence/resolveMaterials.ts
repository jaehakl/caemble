import { dbTables, getListRequest } from '@/api'
import { deserializeCadScene, type EvaluatedExperimentSnapshot } from '@/lib/cad'
import {
  projectMaterialResolution,
  resolveMaterialParameters,
  type FrozenMaterialParameters,
  type MaterialResolution,
} from '@/lib/material'
import { readMeasurementMaterialParameters } from './contracts'

export type MeasurementMaterialResolution = Readonly<{
  materialParameters: FrozenMaterialParameters
  warnings: readonly string[]
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export function createDocumentMaterialResolver(storedSnapshot: unknown | null, sourceOnly = false) {
  const materialNameQueries = new Map<string, ReturnType<typeof dbTables.MaterialName.listRows>>()
  const materialQueries = new Map<string, ReturnType<typeof dbTables.Material.listRows>>()
  const parameterQueries = new Map<string, ReturnType<typeof dbTables.MaterialParameter.listRows>>()

  const resolveOne = async (
    materials: Parameters<typeof resolveMaterialParameters>[0],
    frozen: FrozenMaterialParameters | null,
  ): Promise<MaterialResolution> => {
    if (sourceOnly) return resolveMaterialParameters(materials, [], [], { sourceOnly: true })
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
    if (materialIds.length === 0) return resolveMaterialParameters(materials, names, [])

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
    return resolveMaterialParameters(materials, names, parameters.items, { materials: databaseMaterials.items })
  }

  return async (snapshot: EvaluatedExperimentSnapshot): Promise<MeasurementMaterialResolution> => {
    const taskNames = Object.keys(snapshot.taskScenes).sort()
    const stored = storedSnapshot === null ? null : readMeasurementMaterialParameters(storedSnapshot, taskNames)
    if (storedSnapshot !== null && !stored) {
      throw new Error('저장된 Measurement Material snapshot이 올바르지 않습니다.')
    }

    const commonScene = deserializeCadScene(snapshot.scene)
    const commonMaterials = commonScene.parts.flatMap((part) => (part.material ? [part.material] : []))
    const taskMaterials = Object.fromEntries(
      taskNames.map((name) => {
        const scene = deserializeCadScene(snapshot.taskScenes[name])
        return [name, scene.parts.flatMap((part) => (part.material ? [part.material] : []))]
      }),
    )
    let common: MaterialResolution
    let tasks: readonly (readonly [string, MaterialResolution])[]
    if (!stored || sourceOnly) {
      const shared = await resolveOne([...commonMaterials, ...taskNames.flatMap((name) => taskMaterials[name])], null)
      common = projectMaterialResolution(shared, commonMaterials)
      tasks = taskNames.map((name) => [name, projectMaterialResolution(shared, taskMaterials[name])] as const)
    } else {
      common = await resolveOne(commonMaterials, stored.experiment)
      tasks = await Promise.all(
        taskNames.map(async (name) => [name, await resolveOne(taskMaterials[name], stored.tasks[name])] as const),
      )
    }
    return Object.freeze({
      materialParameters: common.materialParameters,
      warnings: Object.freeze([...common.warnings]),
      taskMaterialParameters: Object.freeze(
        Object.fromEntries(tasks.map(([name, resolution]) => [name, resolution.materialParameters])),
      ),
      taskMaterialWarnings: Object.freeze(
        Object.fromEntries(tasks.map(([name, resolution]) => [name, Object.freeze([...resolution.warnings])])),
      ),
    })
  }
}

export function resolveDocumentMaterials(
  snapshot: EvaluatedExperimentSnapshot,
  storedSnapshot: unknown | null,
  sourceOnly = false,
) {
  return createDocumentMaterialResolver(storedSnapshot, sourceOnly)(snapshot)
}
