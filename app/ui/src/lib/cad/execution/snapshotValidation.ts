import { CadModelError } from '../model/errors'
import type { Vars } from '../model/types'
import { normalizeVars, normalizeVarsSchema, type VarsSchemaEntry } from '../model/vars'
import type { SimulationProgramManifest } from '../simulation/types'
import { assertSimulationProgramManifest } from '../simulation/validation'
import { assertSerializableCadScene, type SerializableCadScene } from './meshValidation'
import {
  assertCanonicalGeometryRunBudget,
  assertCanonicalGeometryScene,
  assertCanonicalTaskSceneCount,
} from '../evaluation/canonical'
import { MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES, type CanonicalGeometrySceneV1 } from '../evaluation/canonicalTypes'

export type EvaluatedExperimentSnapshot = Readonly<{
  kind: 'experiment'
  sourceHash: string
  variables: Readonly<Vars>
  varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  scene: CanonicalGeometrySceneV1
  taskScenes: Readonly<Record<string, CanonicalGeometrySceneV1>>
  renderScene: SerializableCadScene
  taskRenderScenes: Readonly<Record<string, SerializableCadScene>>
  simulationProgram: SimulationProgramManifest
}>

export type EvaluatedDocumentSnapshot = EvaluatedExperimentSnapshot
export type MeasurementExperimentSnapshot = Readonly<
  Omit<EvaluatedExperimentSnapshot, 'renderScene' | 'taskRenderScenes'>
>
export const MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES = MAX_CANONICAL_RENDER_TYPED_ARRAY_BYTES

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
  const allowedKeys = [
    'kind',
    'sourceHash',
    'variables',
    'varsSchema',
    'scene',
    'taskScenes',
    'renderScene',
    'taskRenderScenes',
    'simulationProgram',
  ]
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new CadModelError(`Evaluated Experiment snapshot.${unknownKey} is not allowed.`)
  if (snapshot.kind !== 'experiment') throw new CadModelError('Evaluated snapshot kind must be experiment.')
  if (typeof snapshot.sourceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(snapshot.sourceHash)) {
    throw new CadModelError('Evaluated Experiment snapshot provenance is invalid.')
  }
  const schema = normalizeVarsSchema(snapshot.varsSchema, 'Evaluated Experiment snapshot')
  normalizeVars(schema, snapshot.variables, 'Evaluated Experiment snapshot')
  assertCanonicalGeometryScene(snapshot.scene)
  if (typeof snapshot.taskScenes !== 'object' || snapshot.taskScenes === null || Array.isArray(snapshot.taskScenes)) {
    throw new CadModelError('Evaluated Experiment snapshot Task scenes are invalid.')
  }
  assertCanonicalTaskSceneCount(snapshot.taskScenes)
  Object.entries(snapshot.taskScenes).forEach(([name, scene]) => {
    if (!name.trim()) throw new CadModelError('Evaluated Experiment snapshot Task name is invalid.')
    assertCanonicalGeometryScene(scene)
  })
  assertCanonicalGeometryRunBudget(snapshot.scene, snapshot.taskScenes)
  assertSerializableCadScene(snapshot.renderScene)
  if (
    typeof snapshot.taskRenderScenes !== 'object' ||
    snapshot.taskRenderScenes === null ||
    Array.isArray(snapshot.taskRenderScenes)
  ) {
    throw new CadModelError('Evaluated Experiment snapshot Task render scenes are invalid.')
  }
  const taskRenderScenes = snapshot.taskRenderScenes
  Object.entries(taskRenderScenes).forEach(([name, scene]) => {
    if (!name.trim()) throw new CadModelError('Evaluated Experiment snapshot Task render scene name is invalid.')
    assertSerializableCadScene(scene)
  })
  const simulationProgram = snapshot.simulationProgram
  assertSimulationProgramManifest(simulationProgram, { allowTaskless: true })
  const taskNames = Object.keys(snapshot.taskScenes)
  if (
    taskNames.length !== Object.keys(simulationProgram.tasks).length ||
    taskNames.some((name) => !(name in simulationProgram.tasks)) ||
    taskNames.length !== Object.keys(taskRenderScenes).length ||
    taskNames.some((name) => !(name in taskRenderScenes))
  ) {
    throw new CadModelError('Evaluated Experiment snapshot Task scenes do not match its Simulation Program.')
  }
}

export function assertMeasurementExperimentSnapshot(value: unknown): asserts value is MeasurementExperimentSnapshot {
  assertPlainSnapshotValue(value, 'Measurement Experiment')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CadModelError('Measurement Experiment must be an object.')
  }
  const snapshot = value as Partial<MeasurementExperimentSnapshot>
  const allowedKeys = ['kind', 'sourceHash', 'variables', 'varsSchema', 'scene', 'taskScenes', 'simulationProgram']
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key))
  if (unknownKey) throw new CadModelError(`Measurement Experiment.${unknownKey} is not allowed.`)
  if (
    snapshot.kind !== 'experiment' ||
    typeof snapshot.sourceHash !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(snapshot.sourceHash)
  ) {
    throw new CadModelError('Measurement Experiment provenance is invalid.')
  }
  const schema = normalizeVarsSchema(snapshot.varsSchema, 'Measurement Experiment')
  normalizeVars(schema, snapshot.variables, 'Measurement Experiment')
  assertCanonicalGeometryScene(snapshot.scene)
  if (typeof snapshot.taskScenes !== 'object' || snapshot.taskScenes === null || Array.isArray(snapshot.taskScenes)) {
    throw new CadModelError('Measurement Experiment Task scenes are invalid.')
  }
  assertCanonicalTaskSceneCount(snapshot.taskScenes)
  Object.entries(snapshot.taskScenes).forEach(([name, scene]) => {
    if (!name.trim()) throw new CadModelError('Measurement Experiment Task name is invalid.')
    assertCanonicalGeometryScene(scene)
  })
  assertCanonicalGeometryRunBudget(snapshot.scene, snapshot.taskScenes)
  const simulationProgram = snapshot.simulationProgram
  assertSimulationProgramManifest(simulationProgram, { allowTaskless: true })
  const taskNames = Object.keys(snapshot.taskScenes)
  if (
    taskNames.length !== Object.keys(simulationProgram.tasks).length ||
    taskNames.some((name) => !(name in simulationProgram.tasks))
  ) {
    throw new CadModelError('Measurement Experiment Task scenes do not match its Simulation Program.')
  }
}
