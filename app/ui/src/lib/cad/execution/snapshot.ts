import type { CadScene } from '../evaluation/types'
import type { EvaluatedExperimentSnapshot } from './snapshotTypes'
import { canonicalGeometryScene } from '../evaluation/canonical'
import { renderCanonicalGeometryScene } from './manifoldRender'

export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  MeasurementExperimentSnapshot,
} from './snapshotTypes'

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
  const [scene, ...taskScenes] = await Promise.all([
    canonicalGeometryScene(snapshot.scene),
    ...taskEntries.map(([, taskScene]) => canonicalGeometryScene(taskScene)),
  ])
  const canonicalTaskScenes = Object.freeze(
    Object.fromEntries(taskEntries.map(([name], index) => [name, taskScenes[index]])),
  )
  const renderScene = await renderCanonicalGeometryScene(scene, snapshot.scene)
  const taskRenderScenes: EvaluatedExperimentSnapshot['renderScene'][] = []
  for (let index = 0; index < taskEntries.length; index += 1) {
    taskRenderScenes.push(await renderCanonicalGeometryScene(taskScenes[index], taskEntries[index][1]))
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
