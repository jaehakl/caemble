import type { CadScene } from '../evaluation/types'
import { serializeCadScene } from './mesh'
import type { EvaluatedExperimentSnapshot } from './snapshotValidation'

export {
  MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES,
  assertEvaluatedDocumentSnapshot,
  assertPlainSnapshotValue,
} from './snapshotValidation'
export type { EvaluatedDocumentSnapshot, EvaluatedExperimentSnapshot } from './snapshotValidation'

export type EvaluatedRuntimeDocumentSnapshot = Readonly<
  Omit<EvaluatedExperimentSnapshot, 'scene' | 'taskScenes'> & {
    scene: CadScene
    taskScenes: Readonly<Record<string, CadScene>>
  }
>

export function serializeEvaluatedDocumentSnapshot(
  snapshot: EvaluatedRuntimeDocumentSnapshot,
): EvaluatedExperimentSnapshot {
  return Object.freeze({
    ...snapshot,
    scene: serializeCadScene(snapshot.scene),
    taskScenes: Object.freeze(
      Object.fromEntries(Object.entries(snapshot.taskScenes).map(([name, scene]) => [name, serializeCadScene(scene)])),
    ),
  })
}
