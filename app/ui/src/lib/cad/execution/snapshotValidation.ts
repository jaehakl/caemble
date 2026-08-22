import { CadModelError } from '../model/errors'
import type { Vars } from '../model/types'
import { normalizeVars, normalizeVarsSchema, type VarsSchemaEntry } from '../model/vars'
import type { SimulationProgramManifest } from '../simulation/types'
import { assertSimulationProgramManifest } from '../simulation/validation'
import { assertSerializableCadScene, type SerializableCadScene } from './meshValidation'

export type EvaluatedExperimentSnapshot = Readonly<{
  kind: 'experiment'
  sourceHash: string
  variables: Readonly<Vars>
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  scene: SerializableCadScene
  taskScenes: Readonly<Record<string, SerializableCadScene>>
  simulationProgram: SimulationProgramManifest
}>

export type EvaluatedDocumentSnapshot = EvaluatedExperimentSnapshot
export const MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES = 128 * 1024 * 1024

export function assertPlainSnapshotValue(value: unknown, path = 'snapshot') {
  const activePath = new WeakSet<object>()
  const validated = new WeakSet<object>()
  let nodes = 0
  let typedArrayBytes = 0
  const visit = (current: unknown, currentPath: string, depth: number) => {
    nodes += 1
    if (nodes > 1_000_000 || depth > 128)
      throw new CadModelError(`${currentPath} exceeds the snapshot complexity limit.`)
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
      if (Array.isArray(current)) current.forEach((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1))
      else {
        const prototype = Object.getPrototypeOf(current)
        if (prototype !== Object.prototype && prototype !== null) {
          throw new CadModelError(`${currentPath} must contain only plain objects.`)
        }
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new CadModelError(`${currentPath} cannot contain symbol properties.`)
        }
        Object.entries(Object.getOwnPropertyDescriptors(current)).forEach(([key, descriptor]) => {
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

export function assertEvaluatedDocumentSnapshot(value: unknown): asserts value is EvaluatedExperimentSnapshot {
  assertPlainSnapshotValue(value)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Evaluated Experiment snapshot must be an object.')
  }
  const snapshot = value as Partial<EvaluatedExperimentSnapshot>
  const allowedKeys = ['kind', 'sourceHash', 'variables', 'varsSchema', 'scene', 'taskScenes', 'simulationProgram']
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new CadModelError(`Evaluated Experiment snapshot.${unknownKey} is not allowed.`)
  if (snapshot.kind !== 'experiment') throw new CadModelError('Evaluated snapshot kind must be experiment.')
  if (typeof snapshot.sourceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sourceHash)) {
    throw new CadModelError('Evaluated Experiment snapshot provenance is invalid.')
  }
  const schema = normalizeVarsSchema(snapshot.varsSchema, 'Evaluated Experiment snapshot')
  normalizeVars(schema.normalized, snapshot.variables, 'Evaluated Experiment snapshot')
  assertSerializableCadScene(snapshot.scene)
  if (typeof snapshot.taskScenes !== 'object' || snapshot.taskScenes === null || Array.isArray(snapshot.taskScenes)) {
    throw new CadModelError('Evaluated Experiment snapshot Task scenes are invalid.')
  }
  Object.entries(snapshot.taskScenes).forEach(([name, scene]) => {
    if (!name.trim()) throw new CadModelError('Evaluated Experiment snapshot Task name is invalid.')
    assertSerializableCadScene(scene)
  })
  const simulationProgram = snapshot.simulationProgram
  assertSimulationProgramManifest(simulationProgram, { allowTaskless: true })
  const taskNames = Object.keys(snapshot.taskScenes)
  if (
    taskNames.length !== Object.keys(simulationProgram.tasks).length ||
    taskNames.some((name) => !(name in simulationProgram.tasks))
  ) {
    throw new CadModelError('Evaluated Experiment snapshot Task scenes do not match its Simulation Program.')
  }
}
