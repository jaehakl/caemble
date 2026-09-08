import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import type { MaterialSnapshot } from '@/contracts/material'
import type { EvaluatedRuntimeDocumentSnapshot } from '@/lib/cad/execution/snapshot'
import {
  materialVarsHash,
  projectMaterialResolution,
  resolveMaterialSnapshot,
  selectTaskMaterialModels,
} from '@/lib/material'
import { canonicalMaterialJson } from './resolution'
import { normalizeMaterialModels } from '@/lib/cad/model/materialNormalization'
import { activeCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { DRAFT_TASK_KERNEL } from '@/lib/catalog/draftTask'
import { applyMaterialSnapshot, type MeasurementMaterialResolution } from '@/lib/cad/execution/measurement'

export function resolveSceneMaterials(
  snapshot: EvaluatedRuntimeDocumentSnapshot,
  stored: MeasurementMaterialSnapshot | null = null,
  catalog: CatalogRuntimeSlice = activeCatalogRuntimeSlice(),
): MeasurementMaterialResolution {
  const names = Object.keys(snapshot.taskScenes).sort()
  if (stored && (stored.sourceHash !== snapshot.sourceHash || stored.varsHash !== materialVarsHash(snapshot.variables)))
    throw new Error('Saved Material snapshot does not match the Experiment source and Vars.')
  if (
    stored &&
    (Object.keys(stored.tasks).length !== names.length ||
      names.some((name) => !Object.prototype.hasOwnProperty.call(stored.tasks, name)))
  )
    throw new Error('Saved Material snapshot must match the Experiment tasks.')
  if (stored) {
    for (const model of stored.modelDefinitions) {
      const current = catalog.materialModels.find((item) => item.key === model.key)
      const fields = ['key', 'labelKo', 'description', 'parameterSchema', 'equation', 'conventions'] as const
      if (
        !current ||
        fields.some((field) => canonicalMaterialJson(current[field]) !== canonicalMaterialJson(model[field]))
      )
        throw new Error(`Saved model contract ${model.key} no longer matches the Catalog.`)
    }
  }
  const materials = (scene: typeof snapshot.scene) =>
    scene.parts.flatMap((part) => (part.material ? [part.material] : []))
  const sceneEntries = [
    ['experiment', snapshot.scene],
    ...names.map((name) => [`tasks.${name}`, snapshot.taskScenes[name]] as const),
  ] as const
  const shared = resolveMaterialSnapshot(
    sceneEntries.flatMap(([, scene]) => materials(scene)),
    sceneEntries.flatMap(([scope, scene]) =>
      scene.parts.flatMap((part) => (part.material ? [`${scope}.geometry[${JSON.stringify(part.id)}].material`] : [])),
    ),
  )
  let common = projectMaterialResolution(shared, materials(snapshot.scene)).materialSnapshot
  const tasks: Record<string, MaterialSnapshot> = Object.fromEntries(
    names.map((name) => [
      name,
      projectMaterialResolution(shared, materials(snapshot.taskScenes[name])).materialSnapshot,
    ]),
  )
  if (stored) {
    for (const [scope, authored, frozen] of [
      ['experiment', common, stored.experiment],
      ...names.map((name) => [`tasks.${name}`, tasks[name], stored.tasks[name]] as const),
    ] as const) {
      const expected = Object.keys(authored.materials).sort()
      if (canonicalMaterialJson(expected) !== canonicalMaterialJson(Object.keys(frozen.materials).sort()))
        throw new Error(
          `Saved ${scope}.materials must contain exactly the Materials used by its geometry: ${expected.join(', ')}.`,
        )
      const normalized = {
        materials: Object.fromEntries(
          Object.entries(frozen.materials).map(([name, material]) => [
            name,
            {
              ...(material.color === undefined ? {} : { color: material.color }),
              models: normalizeMaterialModels(
                material.models,
                `${scope}.materials[${JSON.stringify(name)}].models`,
                catalog,
              ),
            },
          ]),
        ),
      }
      if (scope === 'experiment') common = normalized
      else tasks[scope.slice('tasks.'.length)] = normalized
    }
    resolveMaterialSnapshot(
      [common, ...Object.values(tasks)].flatMap((scope) =>
        Object.entries(scope.materials).map(([name, material]) => ({ name, ...material })),
      ),
    )
  }
  const scenes = {
    experiment: applyMaterialSnapshot(snapshot.scene, common),
    tasks: Object.fromEntries(
      names.map((name) => [name, applyMaterialSnapshot(snapshot.taskScenes[name], tasks[name])]),
    ),
  }
  const selections = Object.fromEntries(
    names.map((name) => {
      const task = snapshot.simulationProgram.tasks[name]
      if (task.kernel.name === DRAFT_TASK_KERNEL.name) return [name, {}]
      const solver = catalog.solvers.find(
        (item) => item.name === task.kernel.name && item.version === task.kernel.version,
      )
      if (!solver) throw new Error(`Solver ${task.kernel.name}@${task.kernel.version} is not in the Catalog.`)
      return [
        name,
        selectTaskMaterialModels(
          solver.descriptor,
          task.config as Readonly<Record<string, unknown>>,
          { experiment: scenes.experiment, task: scenes.tasks[name] },
          `tasks.${name}.config`,
        ),
      ]
    }),
  )
  if (stored && canonicalMaterialJson(selections) !== canonicalMaterialJson(stored.selections))
    throw new Error('Saved model selections do not match the Experiment Task selections.')
  const modelIds = new Set(
    [common, ...Object.values(tasks)].flatMap((scope) =>
      Object.values(scope.materials).flatMap((material) => Object.values(material.models).map((model) => model.model)),
    ),
  )
  if (
    stored &&
    (stored.modelDefinitions.length !== modelIds.size ||
      canonicalMaterialJson(stored.modelDefinitions.map((model) => model.key).sort()) !==
        canonicalMaterialJson([...modelIds].sort()))
  )
    throw new Error('Saved modelDefinitions must contain exactly the model contracts used by the Material snapshots.')
  return {
    materialSnapshot: common,
    taskMaterialSnapshots: tasks,
    warnings: [],
    taskMaterialWarnings: Object.fromEntries(names.map((name) => [name, []])),
    modelDefinitions: stored?.modelDefinitions ?? catalog.materialModels.filter((model) => modelIds.has(model.key)),
    materialSelections: selections,
  }
}
