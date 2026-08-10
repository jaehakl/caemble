import { CadModelError } from '../model/errors'
import type { Vars } from '../model/types'
import { normalizeVars, normalizeVarsSchema, type VarsSchemaEntry } from '../model/vars'
import { assertSerializableCadScene, type SerializableCadScene } from './meshValidation'
import type { SimulationProgramManifest } from '../simulation/types'
import { assertSimulationProgramManifest } from '../simulation/validation'

type EvaluatedSnapshotBase = Readonly<{
  sourceHash: string
  seed: number
  variables: Readonly<Vars>
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
}>

export type EvaluatedStructureSnapshot = EvaluatedSnapshotBase &
  Readonly<{
    kind: 'structure'
    scene: SerializableCadScene
  }>

export type EvaluatedExperimentSnapshot = EvaluatedSnapshotBase &
  Readonly<{
    kind: 'experiment'
    taskScenes: Readonly<Record<string, SerializableCadScene>>
    simulationProgram: SimulationProgramManifest
  }>

export type EvaluatedDocumentSnapshot = EvaluatedStructureSnapshot | EvaluatedExperimentSnapshot

export const MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES = 128 * 1024 * 1024

export function assertPlainSnapshotValue(value: unknown, path = 'snapshot') {
  const activePath = new WeakSet<object>()
  const validated = new WeakSet<object>()
  let nodes = 0
  let typedArrayBytes = 0

  const visit = (current: unknown, currentPath: string, depth: number) => {
    nodes += 1
    if (nodes > 1_000_000 || depth > 128) {
      throw new CadModelError(`${currentPath} exceeds the snapshot complexity limit.`)
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new CadModelError(`${currentPath} must contain finite numbers.`)
      return
    }
    if (typeof current !== 'object') throw new CadModelError(`${currentPath} contains a non-serializable value.`)
    if (activePath.has(current)) throw new CadModelError(`${currentPath} contains a cyclic value.`)
    if (validated.has(current)) return
    if (ArrayBuffer.isView(current)) {
      if (current instanceof DataView || current instanceof BigInt64Array || current instanceof BigUint64Array) {
        throw new CadModelError(`${currentPath} contains an unsupported binary view.`)
      }
      typedArrayBytes += current.byteLength
      if (typedArrayBytes > MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES) {
        throw new CadModelError(`${currentPath} exceeds the snapshot binary-data limit.`)
      }
      validated.add(current)
      return
    }
    activePath.add(current)
    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1))
      } else {
        const prototype = Object.getPrototypeOf(current)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new CadModelError(`${currentPath} must contain only plain objects.`)
        }
        const descriptors = Object.getOwnPropertyDescriptors(current)
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new CadModelError(`${currentPath} cannot contain symbol properties.`)
        }
        Object.entries(descriptors).forEach(([key, descriptor]) => {
          if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
            throw new CadModelError(`${currentPath}.${key} is not allowed in a snapshot.`)
          }
          if ('get' in descriptor || 'set' in descriptor) {
            throw new CadModelError(`${currentPath}.${key} cannot be an accessor.`)
          }
          visit(descriptor.value, `${currentPath}.${key}`, depth + 1)
        })
      }
      validated.add(current)
    } finally {
      activePath.delete(current)
    }
  }

  visit(value, path, 0)
}

export function assertEvaluatedDocumentSnapshot(value: unknown): asserts value is EvaluatedDocumentSnapshot {
  assertPlainSnapshotValue(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Evaluated document snapshot must be an object.')
  }
  const snapshot = value as Partial<EvaluatedDocumentSnapshot>
  if (snapshot.kind !== 'structure' && snapshot.kind !== 'experiment') {
    throw new CadModelError('Evaluated document snapshot kind is invalid.')
  }
  if (typeof snapshot.sourceHash !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot.sourceHash)) {
    throw new CadModelError('Evaluated document snapshot provenance is invalid.')
  }
  if (!Number.isSafeInteger(snapshot.seed) || snapshot.seed! < 0) {
    throw new CadModelError('Evaluated document snapshot seed is invalid.')
  }
  if (typeof snapshot.variables !== 'object' || snapshot.variables === null || Array.isArray(snapshot.variables)) {
    throw new CadModelError('Evaluated document snapshot variables are invalid.')
  }
  const schema = normalizeVarsSchema(snapshot.varsSchema, 'Evaluated document snapshot')
  normalizeVars(schema.normalized, snapshot.variables, 'Evaluated document snapshot')
  if (snapshot.kind === 'experiment') {
    if (
      typeof snapshot.taskScenes !== 'object' ||
      snapshot.taskScenes === null ||
      Array.isArray(snapshot.taskScenes) ||
      Object.keys(snapshot.taskScenes).length === 0
    ) {
      throw new CadModelError('Evaluated Experiment snapshot Task scenes are invalid.')
    }
    Object.entries(snapshot.taskScenes).forEach(([name, scene]) => {
      if (!name.trim()) throw new CadModelError('Evaluated Experiment snapshot Task name is invalid.')
      assertSerializableCadScene(scene)
    })
    if (
      Object.keys(snapshot.taskScenes).length !== Object.keys(snapshot.simulationProgram?.tasks ?? {}).length ||
      Object.keys(snapshot.taskScenes).some((name) => !(name in (snapshot.simulationProgram?.tasks ?? {})))
    ) {
      throw new CadModelError('Evaluated Experiment snapshot Task scenes do not match its Simulation Program.')
    }
    assertSimulationProgramManifest(snapshot.simulationProgram)
  } else assertSerializableCadScene((snapshot as Partial<EvaluatedStructureSnapshot>).scene)
  const allowedKeys =
    snapshot.kind === 'experiment'
      ? ['kind', 'sourceHash', 'seed', 'variables', 'varsSchema', 'taskScenes', 'simulationProgram']
      : ['kind', 'sourceHash', 'seed', 'variables', 'varsSchema', 'scene']
  const unknownKey = Object.keys(snapshot).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new CadModelError(`Evaluated document snapshot.${unknownKey} is not allowed.`)
}
