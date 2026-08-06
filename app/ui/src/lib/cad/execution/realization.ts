import type { FrozenMaterialParameters, MaterialResolution } from '../../material'
import { readFrozenMaterialParameters } from '../../material'
import { materialParameterByKey } from '../../material/data'
import { sourceOnlyMaterialParameters } from '../../material'
import { QuantityKind } from '../../quantitykind'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import type { CadScene } from '../evaluation/types'
import { deserializeCadScene } from './mesh'
import { CadModelError } from '../model/errors'
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
  materialParameters: FrozenMaterialParameters
  materialWarnings: readonly string[]
}>

export type BuiltRealization = BuiltSample | BuiltSetup

export function buildRealization(
  snapshot: EvaluatedDocumentSnapshot,
  resolution: MaterialResolution,
): BuiltRealization {
  if (snapshot.kind === 'structure') {
    return Object.freeze({
      kind: 'sample',
      structure: snapshot,
      materialParameters: resolution.materialParameters,
      materialWarnings: Object.freeze([...resolution.warnings]),
    })
  }
  return Object.freeze({
    kind: 'setup',
    experiment: snapshot,
    materialParameters: resolution.materialParameters,
    materialWarnings: Object.freeze([...resolution.warnings]),
  })
}

export function buildSourceOnlyRealization(snapshot: EvaluatedDocumentSnapshot) {
  const scene = deserializeCadScene(snapshot.scene)
  const materials = scene.parts.flatMap((part) => (part.material ? [part.material] : []))
  return buildRealization(snapshot, sourceOnlyMaterialParameters(materials))
}

export function assertBuiltRealization(value: unknown): asserts value is BuiltRealization {
  assertPlainSnapshotValue(value, 'built realization')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Built realization must be an object.')
  }
  const realization = value as Partial<BuiltRealization>
  const snapshot =
    realization.kind === 'sample' ? realization.structure : realization.kind === 'setup' ? realization.experiment : null
  if (!snapshot || (realization.kind === 'sample' ? snapshot.kind !== 'structure' : snapshot.kind !== 'experiment')) {
    throw new CadModelError('Built realization kind does not match its evaluated document.')
  }
  assertEvaluatedDocumentSnapshot(snapshot)
  if (!readFrozenMaterialParameters(realization.materialParameters)) {
    throw new CadModelError('Built realization Material snapshot is invalid.')
  }
  if (
    !Array.isArray(realization.materialWarnings) ||
    realization.materialWarnings.some((warning) => typeof warning !== 'string')
  ) {
    throw new CadModelError('Built realization Material warnings are invalid.')
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
