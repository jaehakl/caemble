import type { MaterialSnapshot, TaskMaterialSelections } from '@/contracts/material'
import type { CatalogMaterialModel } from '@/contracts/catalog'
import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
import { materialVarsHash, type MaterialResolution } from '../../material/resolution'
import type { CadScene } from '../evaluation/types'
import type { MeasurementExperimentSnapshot } from './snapshotTypes'

export type TaskMaterialResolution = Readonly<{
  taskMaterialSnapshots: Readonly<Record<string, MaterialSnapshot>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export type MeasurementMaterialResolution = MaterialResolution &
  TaskMaterialResolution &
  Readonly<{
    modelDefinitions: readonly CatalogMaterialModel[]
    materialSelections: Readonly<Record<string, TaskMaterialSelections>>
  }>

export type BuiltMeasurement = Readonly<{
  kind: 'measurement'
  experiment: MeasurementExperimentSnapshot
  varsHash: string
  materialSnapshot: MaterialSnapshot
  taskMaterialSnapshots: Readonly<Record<string, MaterialSnapshot>>
  modelDefinitions: readonly CatalogMaterialModel[]
  materialSelections: Readonly<Record<string, TaskMaterialSelections>>
}>

export function buildMeasurement(
  snapshot: MeasurementExperimentSnapshot,
  resolution: MeasurementMaterialResolution,
): BuiltMeasurement {
  const experiment: MeasurementExperimentSnapshot = {
    kind: snapshot.kind,
    sourceHash: snapshot.sourceHash,
    variables: snapshot.variables,
    varsSchema: snapshot.varsSchema,
    scene: snapshot.scene,
    taskScenes: snapshot.taskScenes,
    simulationProgram: snapshot.simulationProgram,
  }
  return Object.freeze({
    kind: 'measurement',
    experiment: Object.freeze(experiment),
    varsHash: materialVarsHash(snapshot.variables),
    materialSnapshot: resolution.materialSnapshot,
    taskMaterialSnapshots: resolution.taskMaterialSnapshots,
    modelDefinitions: resolution.modelDefinitions,
    materialSelections: resolution.materialSelections,
  })
}

export function measurementMaterialSnapshot(built: BuiltMeasurement): MeasurementMaterialSnapshot {
  return Object.freeze({
    experiment: built.materialSnapshot,
    tasks: built.taskMaterialSnapshots,
    sourceHash: built.experiment.sourceHash,
    varsHash: built.varsHash,
    modelDefinitions: built.modelDefinitions,
    selections: built.materialSelections,
  })
}

export function applyMaterialSnapshot(scene: CadScene, frozen: MaterialSnapshot): CadScene {
  return {
    ...scene,
    parts: scene.parts.map((part) => {
      if (!part.material) return part
      const definition = frozen.materials[part.material.name]
      if (!definition) throw new Error(`Saved Material ${part.material.name} is missing from the snapshot.`)
      return { ...part, material: Object.freeze({ name: part.material.name, ...definition }) }
    }),
  }
}
