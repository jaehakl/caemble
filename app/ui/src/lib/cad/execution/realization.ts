import type { FrozenMaterialParameters, MaterialResolution } from '../../material'
import { readFrozenMaterialParameters } from '../../material'
import { materialParameterByKey } from '../../material/data'
import { sourceOnlyMaterialParameters } from '../../material'
import { QuantityKind } from '../../quantitykind'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import type { CadScene } from '../evaluation/types'
import { CadModelError } from '../model/errors'
import { deserializeCadScene } from './mesh'
import {
  assertEvaluatedDocumentSnapshot,
  assertPlainSnapshotValue,
  type EvaluatedDocumentSnapshot,
  type EvaluatedExperimentSnapshot,
  type EvaluatedStructureSnapshot,
} from './snapshotValidation'

export type BuiltSample = Readonly<{
  kind: 'sample'
  structure: EvaluatedStructureSnapshot
  materialParameters: FrozenMaterialParameters
  materialWarnings: readonly string[]
}>

export type BuiltSetup = Readonly<{
  kind: 'setup'
  experiment: EvaluatedExperimentSnapshot
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export type BuiltRealization = BuiltSample | BuiltSetup

export type TaskMaterialResolution = Readonly<{
  taskMaterialParameters: Readonly<Record<string, FrozenMaterialParameters>>
  taskMaterialWarnings: Readonly<Record<string, readonly string[]>>
}>

export function buildRealization(
  snapshot: EvaluatedDocumentSnapshot,
  resolution: MaterialResolution | TaskMaterialResolution,
): BuiltRealization {
  if (snapshot.kind === 'structure') {
    if (!('materialParameters' in resolution)) {
      throw new CadModelError('Structure realization requires a Material snapshot.')
    }
    return Object.freeze({
      kind: 'sample',
      structure: snapshot,
      materialParameters: resolution.materialParameters,
      materialWarnings: Object.freeze([...resolution.warnings]),
    })
  }
  if (!('taskMaterialParameters' in resolution)) {
    throw new CadModelError('Experiment realization requires Task material snapshots.')
  }
  return Object.freeze({
    kind: 'setup',
    experiment: snapshot,
    taskMaterialParameters: resolution.taskMaterialParameters,
    taskMaterialWarnings: resolution.taskMaterialWarnings,
  })
}

export function buildSourceOnlyRealization(snapshot: EvaluatedDocumentSnapshot) {
  if (snapshot.kind === 'structure') {
    const scene = deserializeCadScene(snapshot.scene)
    const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
    return buildRealization(snapshot, sourceOnlyMaterialParameters(materials))
  }
  const resolutions = Object.fromEntries(
    Object.entries(snapshot.taskScenes).map(([name, serialized]) => {
      const scene = deserializeCadScene(serialized)
      const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
      return [name, sourceOnlyMaterialParameters(materials)]
    }),
  )
  return buildRealization(snapshot, {
    taskMaterialParameters: Object.freeze(
      Object.fromEntries(Object.entries(resolutions).map(([name, item]) => [name, item.materialParameters])),
    ),
    taskMaterialWarnings: Object.freeze(
      Object.fromEntries(Object.entries(resolutions).map(([name, item]) => [name, Object.freeze([...item.warnings])])),
    ),
  })
}

export function assertBuiltRealization(value: unknown): asserts value is BuiltRealization {
  assertPlainSnapshotValue(value, 'built realization')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Built realization must be an object.')
  }
  const realization = value as { kind?: unknown }
  const snapshot =
    realization.kind === 'sample'
      ? (value as Partial<BuiltSample>).structure
      : realization.kind === 'setup'
        ? (value as Partial<BuiltSetup>).experiment
        : null
  if (!snapshot || (realization.kind === 'sample' ? snapshot.kind !== 'structure' : snapshot.kind !== 'experiment')) {
    throw new CadModelError('Built realization kind does not match its evaluated document.')
  }
  assertEvaluatedDocumentSnapshot(snapshot)
  if (realization.kind === 'sample') {
    const sample = value as Partial<BuiltSample>
    if (!readFrozenMaterialParameters(sample.materialParameters)) {
      throw new CadModelError('Built Sample Material snapshot is invalid.')
    }
    if (!Array.isArray(sample.materialWarnings) || sample.materialWarnings.some((item) => typeof item !== 'string')) {
      throw new CadModelError('Built Sample Material warnings are invalid.')
    }
  } else {
    const setup = value as Partial<BuiltSetup>
    if (!setup.experiment || !setup.taskMaterialParameters || !setup.taskMaterialWarnings) {
      throw new CadModelError('Built Setup Task material snapshots are invalid.')
    }
    const taskNames = Object.keys(setup.experiment.taskScenes)
    if (
      taskNames.some((name) => !readFrozenMaterialParameters(setup.taskMaterialParameters![name])) ||
      taskNames.some(
        (name) =>
          !Array.isArray(setup.taskMaterialWarnings![name]) ||
          setup.taskMaterialWarnings![name].some((item: unknown) => typeof item !== 'string'),
      ) ||
      Object.keys(setup.taskMaterialParameters).length !== taskNames.length ||
      Object.keys(setup.taskMaterialWarnings).length !== taskNames.length
    ) {
      throw new CadModelError('Built Setup Task material snapshots are invalid.')
    }
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
      const variables: Record<string, unknown> = {
        ...(color === undefined ? {} : { color }),
      }
      Object.entries(entries).forEach(([name, entry]) => {
        const definition = materialParameterByKey[name as keyof typeof materialParameterByKey]
        variables[name] =
          definition && 'dtype' in entry.value
            ? Object.freeze({
                ...entry.value,
                quantityKind: definition.quantity_kind,
                ...(QuantityKind[definition.quantity_kind].tensorOrder() === 0
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
