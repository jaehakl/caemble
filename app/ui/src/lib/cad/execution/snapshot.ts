import type { CadScene } from '../evaluation/types'
import type { EvaluatedExperimentSnapshot } from './snapshotValidation'
import {
  assertCanonicalGeometryRunBudget,
  assertCanonicalTaskSceneCount,
  canonicalGeometryScene,
} from '../evaluation/canonical'
import { renderCanonicalGeometryScene } from './manifoldRender'

export {
  MAX_CAD_SNAPSHOT_TYPED_ARRAY_BYTES,
  assertEvaluatedDocumentSnapshot,
  assertPlainSnapshotValue,
} from './snapshotValidation'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  MeasurementExperimentSnapshot,
} from './snapshotValidation'

export type EvaluatedRuntimeDocumentSnapshot = Readonly<
  Omit<EvaluatedExperimentSnapshot, 'scene' | 'taskScenes' | 'renderScene' | 'taskRenderScenes'> & {
    scene: CadScene
    taskScenes: Readonly<Record<string, CadScene>>
  }
>

export async function serializeEvaluatedDocumentSnapshot(
  snapshot: EvaluatedRuntimeDocumentSnapshot,
): Promise<EvaluatedExperimentSnapshot> {
  const taskEntries = Object.entries(snapshot.taskScenes)
  assertCanonicalTaskSceneCount(snapshot.taskScenes)
  const [scene, ...taskScenes] = await Promise.all([
    canonicalGeometryScene(snapshot.scene),
    ...taskEntries.map(([, taskScene]) => canonicalGeometryScene(taskScene)),
  ])
  const canonicalTaskScenes = Object.freeze(
    Object.fromEntries(taskEntries.map(([name], index) => [name, taskScenes[index]])),
  )
  assertCanonicalGeometryRunBudget(scene, canonicalTaskScenes)
  const renderUsage = { triangles: 0, typedArrayBytes: 0 }
  const renderScene = await renderCanonicalGeometryScene(scene, snapshot.scene, renderUsage)
  const taskRenderScenes: EvaluatedExperimentSnapshot['renderScene'][] = []
  for (let index = 0; index < taskEntries.length; index += 1) {
    taskRenderScenes.push(await renderCanonicalGeometryScene(taskScenes[index], taskEntries[index][1], renderUsage))
  }
  return Object.freeze({
    ...snapshot,
    scene,
    taskScenes: canonicalTaskScenes,
    renderScene,
    taskRenderScenes: Object.freeze(
      Object.fromEntries(taskEntries.map(([name], index) => [name, taskRenderScenes[index]])),
    ),
  })
}
