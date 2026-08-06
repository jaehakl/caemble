import type { FrozenMaterialParameters, MaterialResolution } from '../../material'
import { readFrozenMaterialParameters } from '../../material'
import { materialParameterByKey } from '../../material/data'
import { sourceOnlyMaterialParameters } from '../../material'
import { QuantityKind } from '../../quantitykind'
import { identityCartesianBasis } from '../../quantitykind/identityBasis'
import { getQuantityKindComponentShape, transformQuantityValue } from '../../quantitykind/runtime'
import type { CadScene } from '../evaluation/types'
import { normalizeDataValueDescriptor } from '../model/core'
import { CadModelError } from '../model/errors'
import { convertUcumValue } from '../model/units'
import { kernelModules } from '../simulation/kernels'
import type { KernelDataSpec, KernelDescriptor } from '../simulation/kernelContract'
import { cadSceneHash, deserializeCadScene, type SerializableCadScene } from './mesh'
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

function descriptorsFor(setup: BuiltSetup) {
  return Object.values(setup.experiment.simulationProgram.tasks).map((task) => {
    const descriptor = kernelModules.find(
      (module) => module.descriptor.name === task.kernel.name && module.descriptor.version === task.kernel.version,
    )?.descriptor
    if (!descriptor) {
      throw new CadModelError(`CAE solver ${task.kernel.name}@${task.kernel.version} is not registered in the UI.`)
    }
    return descriptor
  })
}

function canonicalScene(scene: SerializableCadScene, unit: string): SerializableCadScene {
  if (scene.lengthUnit === unit) return scene
  const scale = convertUcumValue(1, scene.lengthUnit, unit, 'CAE geometry canonicalization')
  const parts = scene.parts.map((part) =>
    Object.freeze({
      ...part,
      geometry: Object.freeze({
        ...part.geometry,
        positions: Float64Array.from(part.geometry.positions, (coordinate) => coordinate * scale),
      }),
    }),
  )
  const canonical = {
    lengthUnit: unit,
    parts,
    tree: scene.tree,
    geometryGroups: scene.geometryGroups,
    surfaceGroups: scene.surfaceGroups,
  }
  return Object.freeze({ ...canonical, sceneHash: cadSceneHash(canonical) })
}

function canonicalMaterialParameters(
  frozen: FrozenMaterialParameters,
  properties: ReadonlyMap<string, KernelDataSpec>,
): FrozenMaterialParameters {
  const materials = Object.fromEntries(
    Object.entries(frozen.materials).map(([materialName, entries]) => [
      materialName,
      Object.freeze(
        Object.fromEntries(
          Object.entries(entries).map(([name, entry]) => {
            const target = properties.get(name)
            if (!target || !('dtype' in entry.value)) return [name, entry]
            if (
              !target.dtype.startsWith('float') ||
              typeof target.unit !== 'string' ||
              typeof target.quantityKind !== 'string'
            ) {
              throw new CadModelError(`CAE material property ${name} must use a float quantity schema.`)
            }
            const value = transformQuantityValue(
              entry.value.value,
              getQuantityKindComponentShape(target.quantityKind),
              { unit: entry.value.unit },
              { unit: target.unit, ...(target.basis === undefined ? {} : { basis: target.basis }) },
              `Material ${materialName}.${name}`,
            )
            const normalized = normalizeDataValueDescriptor(
              {
                dtype: target.dtype,
                unit: target.unit,
                quantityKind: target.quantityKind,
                ...(target.basis === undefined ? {} : { basis: target.basis }),
                value,
              },
              `Material ${materialName}.${name}`,
            )
            return [
              name,
              Object.freeze({
                ...entry,
                value: Object.freeze({
                  dtype: normalized.dtype,
                  unit: normalized.unit,
                  value: normalized.value,
                }),
              }),
            ]
          }),
        ),
      ),
    ]),
  )
  return Object.freeze({
    ...frozen,
    materials: Object.freeze(materials),
  })
}

export function canonicalizeCaeRealizations(
  sample: BuiltSample,
  setup: BuiltSetup,
): Readonly<{ sample: BuiltSample; setup: BuiltSetup }> {
  const descriptors = descriptorsFor(setup)
  if (descriptors.length === 0) return Object.freeze({ sample, setup })
  const units = new Set(descriptors.map((descriptor) => descriptor.referenceLengthUnit))
  if (units.size !== 1) {
    throw new CadModelError('All CAE tasks in one Experiment must use the same reference length unit.')
  }
  const unit = [...units][0]
  const properties = new Map<string, KernelDataSpec>()
  descriptors.forEach((descriptor: KernelDescriptor) => {
    descriptor.materials.forEach((material) => {
      Object.entries(material.properties).forEach(([name, property]) => {
        const current = properties.get(name)
        if (current && JSON.stringify(current) !== JSON.stringify(property.data)) {
          throw new CadModelError(`CAE material property ${name} has conflicting solver schemas.`)
        }
        properties.set(name, property.data)
      })
    })
  })
  return Object.freeze({
    sample: Object.freeze({
      ...sample,
      structure: Object.freeze({ ...sample.structure, scene: canonicalScene(sample.structure.scene, unit) }),
      materialParameters: canonicalMaterialParameters(sample.materialParameters, properties),
    }),
    setup: Object.freeze({
      ...setup,
      experiment: Object.freeze({ ...setup.experiment, scene: canonicalScene(setup.experiment.scene, unit) }),
      materialParameters: canonicalMaterialParameters(setup.materialParameters, properties),
    }),
  })
}

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
