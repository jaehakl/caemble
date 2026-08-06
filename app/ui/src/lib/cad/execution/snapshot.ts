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
  | Readonly<Omit<EvaluatedExperimentSnapshot, 'scene'> & { scene: CadScene }>

export function serializeEvaluatedDocumentSnapshot(
  snapshot: EvaluatedRuntimeDocumentSnapshot,
): EvaluatedDocumentSnapshot {
  return Object.freeze({ ...snapshot, scene: serializeCadScene(snapshot.scene) })
}
