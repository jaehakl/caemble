import type { FrozenMaterialParameters, MaterialResolution } from '../../material'
import { projectMaterialResolution, sourceOnlyMaterialParameters } from '../../material'
import { getRuntimeMaterialParameter } from '../../catalog/runtime'
import { QuantityKind } from '../../quantitykind'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import type { CadScene } from '../evaluation/types'
import { deserializeCadScene } from './mesh'
import type { EvaluatedExperimentSnapshot, MeasurementExperimentSnapshot } from './snapshotTypes'

export type TaskMaterialResolution = Readonly<{
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export type MeasurementMaterialResolution = MaterialResolution & TaskMaterialResolution

export type BuiltMeasurement = Readonly<{
  kind: 'measurement'
  experiment: MeasurementExperimentSnapshot
  materialParameters: FrozenMaterialParameters
  materialWarnings: readonly string[]
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export function unresolvedMeasurementMaterialRoles(snapshot: EvaluatedExperimentSnapshot) {
  const unresolved = new Set<string>()
  snapshot.scene.roots.forEach((root) => {
    if (!root.material) unresolved.add(`Experiment: ${root.materialRole}`)
  })
  Object.entries(snapshot.taskScenes).forEach(([taskName, scene]) => {
    scene.roots.forEach((root) => {
      if (!root.material) unresolved.add(`Task ${taskName}: ${root.materialRole}`)
    })
  })
  return Object.freeze([...unresolved])
}

export function buildMeasurement(
  snapshot: EvaluatedExperimentSnapshot,
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
  const measurement = Object.freeze({
    kind: 'measurement' as const,
    experiment: Object.freeze(experiment),
    materialParameters: resolution.materialParameters,
    materialWarnings: Object.freeze([...resolution.warnings]),
    taskMaterialParameters: resolution.taskMaterialParameters,
    taskMaterialWarnings: resolution.taskMaterialWarnings,
  })
  return measurement
}

export function buildSourceOnlyMeasurement(snapshot: EvaluatedExperimentSnapshot) {
  const experimentMaterials = deserializeCadScene(snapshot.renderScene).parts.flatMap((part) =>
    part.material ? [part.material] : [],
  )
  const taskMaterials = Object.fromEntries(
    Object.entries(snapshot.taskRenderScenes).map(([name, scene]) => [
      name,
      deserializeCadScene(scene).parts.flatMap((part) => (part.material ? [part.material] : [])),
    ]),
  )
  const sharedResolution = sourceOnlyMaterialParameters([
    ...experimentMaterials,
    ...Object.values(taskMaterials).flat(),
  ])
  const experimentResolution = projectMaterialResolution(sharedResolution, experimentMaterials)
  const taskResolutions = Object.fromEntries(
    Object.entries(taskMaterials).map(([name, materials]) => [
      name,
      projectMaterialResolution(sharedResolution, materials),
    ]),
  )
  return buildMeasurement(snapshot, {
    materialParameters: experimentResolution.materialParameters,
    warnings: experimentResolution.warnings,
    taskMaterialParameters: Object.freeze(
      Object.fromEntries(Object.entries(taskResolutions).map(([name, item]) => [name, item.materialParameters])),
    ),
    taskMaterialWarnings: Object.freeze(
      Object.fromEntries(
        Object.entries(taskResolutions).map(([name, item]) => [name, Object.freeze([...item.warnings])]),
      ),
    ),
  })
}

export function applyFrozenMaterialParameters(scene: CadScene, frozen: FrozenMaterialParameters): CadScene {
  return {
    ...scene,
    parts: scene.parts.map((part) => {
      if (!part.material) return part
      const entries = frozen.materials[part.material.name]
      if (!entries) return part
      const color = part.material.variables.color ?? frozen.materialColors?.[part.material.name]?.color
      const variables: Record<string, unknown> = { ...(color === undefined ? {} : { color }) }
      Object.entries(entries).forEach(([name, entry]) => {
        const definition = getRuntimeMaterialParameter(name)
        variables[name] =
          definition && 'dtype' in entry.value
            ? Object.freeze({
                ...entry.value,
                quantityKind: definition.quantityKind,
                ...(QuantityKind[definition.quantityKind].tensorOrder() === 0 ? {} : { basis: identityCartesianBasis }),
              })
            : entry.value
      })
      return {
        ...part,
        material: Object.freeze({ ...part.material, variables: Object.freeze(variables) }),
      }
    }),
  }
}
