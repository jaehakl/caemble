import type { CadScene } from '../evaluation/types'
import { serializeCadScene } from './mesh'
import type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedStructureSnapshot,
} from './snapshotValidation'

export {
  MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES,
  assertEvaluatedDocumentSnapshot,
  assertPlainSnapshotValue,
} from './snapshotValidation'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedStructureSnapshot,
} from './snapshotValidation'

export type EvaluatedRuntimeDocumentSnapshot =
  | Readonly<Omit<EvaluatedStructureSnapshot, 'scene'> & { scene: CadScene }>
  | Readonly<Omit<EvaluatedExperimentSnapshot, 'taskScenes'> & { taskScenes: Readonly<Record<string, CadScene>> }>

export function serializeEvaluatedDocumentSnapshot(
  snapshot: EvaluatedRuntimeDocumentSnapshot,
): EvaluatedDocumentSnapshot {
  if (snapshot.kind === 'structure') {
    return Object.freeze({ ...snapshot, scene: serializeCadScene(snapshot.scene) })
  }
  return Object.freeze({
    ...snapshot,
    taskScenes: Object.freeze(
      Object.fromEntries(Object.entries(snapshot.taskScenes).map(([name, scene]) => [name, serializeCadScene(scene)])),
    ),
  })
}
