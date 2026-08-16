import type { FrozenMaterialParameters, MaterialResolution } from '../../material'
import { projectMaterialResolution, readFrozenMaterialParameters, sourceOnlyMaterialParameters } from '../../material'
import { getRuntimeMaterialParameter } from '../../catalog/runtime'
import { QuantityKind } from '../../quantitykind'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import type { CadScene } from '../evaluation/types'
import { CadModelError } from '../model/errors'
import { deserializeCadScene } from './mesh'
import {
  assertEvaluatedDocumentSnapshot,
  assertPlainSnapshotValue,
  type EvaluatedExperimentSnapshot,
} from './snapshotValidation'

export type TaskMaterialResolution = Readonly<{
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export type MeasurementMaterialResolution = MaterialResolution & TaskMaterialResolution

export type BuiltMeasurement = Readonly<{
  kind: 'measurement'
  experiment: EvaluatedExperimentSnapshot
  materialParameters: FrozenMaterialParameters
  materialWarnings: readonly string[]
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export function unresolvedMeasurementMaterialRoles(snapshot: EvaluatedExperimentSnapshot) {
  const unresolved = new Set<string>()
  snapshot.scene.parts.forEach((part) => {
    if (!part.material) unresolved.add(`Experiment: ${part.materialRole}`)
  })
  Object.entries(snapshot.taskScenes).forEach(([taskName, scene]) => {
    scene.parts.forEach((part) => {
      if (!part.material) unresolved.add(`Task ${taskName}: ${part.materialRole}`)
    })
  })
  return Object.freeze([...unresolved])
}

export function buildMeasurement(
  snapshot: EvaluatedExperimentSnapshot,
  resolution: MeasurementMaterialResolution,
): BuiltMeasurement {
  const unresolved = unresolvedMeasurementMaterialRoles(snapshot)
  if (unresolved.length > 0) {
    throw new CadModelError(`Measurement requires resolved Material roles: ${unresolved.join(', ')}.`)
  }
  const measurement = Object.freeze({
    kind: 'measurement' as const,
    experiment: snapshot,
    materialParameters: resolution.materialParameters,
    materialWarnings: Object.freeze([...resolution.warnings]),
    taskMaterialParameters: resolution.taskMaterialParameters,
    taskMaterialWarnings: resolution.taskMaterialWarnings,
  })
  assertBuiltMeasurement(measurement)
  return measurement
}

export function buildSourceOnlyMeasurement(snapshot: EvaluatedExperimentSnapshot) {
  const experimentMaterials = deserializeCadScene(snapshot.scene).parts.flatMap((part) =>
    part.material ? [part.material] : [],
  )
  const taskMaterials = Object.fromEntries(
    Object.entries(snapshot.taskScenes).map(([name, scene]) => [
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

export function assertBuiltMeasurement(value: unknown): asserts value is BuiltMeasurement {
  assertPlainSnapshotValue(value, 'built Measurement')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Built Measurement must be an object.')
  }
  const measurement = value as Partial<BuiltMeasurement>
  const unknownKey = Object.keys(value).find(
    (key) =>
      ![
        'kind',
        'experiment',
        'materialParameters',
        'materialWarnings',
        'taskMaterialParameters',
        'taskMaterialWarnings',
      ].includes(key),
  )
  if (unknownKey) throw new CadModelError(`Built Measurement.${unknownKey} is not allowed.`)
  if (measurement.kind !== 'measurement' || measurement.experiment?.kind !== 'experiment') {
    throw new CadModelError('Built Measurement kind does not match its Experiment.')
  }
  assertEvaluatedDocumentSnapshot(measurement.experiment)
  const unresolved = unresolvedMeasurementMaterialRoles(measurement.experiment)
  if (unresolved.length > 0) {
    throw new CadModelError(`Built Measurement contains unresolved Material roles: ${unresolved.join(', ')}.`)
  }
  if (!readFrozenMaterialParameters(measurement.materialParameters)) {
    throw new CadModelError('Built Measurement Experiment Material snapshot is invalid.')
  }
  if (
    !Array.isArray(measurement.materialWarnings) ||
    measurement.materialWarnings.some((item) => typeof item !== 'string')
  ) {
    throw new CadModelError('Built Measurement Experiment Material warnings are invalid.')
  }
  if (!measurement.taskMaterialParameters || !measurement.taskMaterialWarnings) {
    throw new CadModelError('Built Measurement Task Material snapshots are invalid.')
  }
  const taskNames = Object.keys(measurement.experiment.taskScenes)
  if (
    taskNames.some((name) => !readFrozenMaterialParameters(measurement.taskMaterialParameters![name])) ||
    taskNames.some(
      (name) =>
        !Array.isArray(measurement.taskMaterialWarnings![name]) ||
        measurement.taskMaterialWarnings![name].some((item: unknown) => typeof item !== 'string'),
    ) ||
    Object.keys(measurement.taskMaterialParameters).length !== taskNames.length ||
    Object.keys(measurement.taskMaterialWarnings).length !== taskNames.length
  ) {
    throw new CadModelError('Built Measurement Task Material snapshots are invalid.')
  }
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
                ...(QuantityKind[definition.quantityKind].tensorOrder() === 0
                  ? {}
                  : { basis: identityCartesianBasis }),
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
