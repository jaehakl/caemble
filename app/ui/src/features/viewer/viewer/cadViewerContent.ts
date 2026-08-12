import type { CadScene, Vars } from '@/lib/cad'
import type { JscadViewerLayer } from './sourceLayers'

export type CadViewerDocument = Readonly<{
  scene: CadScene | null
  sceneHash?: string | null
  taskScenes?: Readonly<Record<string, CadScene>>
  taskSceneHashes?: Readonly<Record<string, string>>
  variables: Readonly<Vars> | null
}>

export function resolveCadViewerContent(
  experiment: CadViewerDocument | null,
  experimentVisible: boolean,
  taskVisible: boolean,
  activeExperimentTaskName: string | null = null,
) {
  const availableSources = [
    ...(experiment?.scene ? ['experiment' as const] : []),
    ...(Object.keys(experiment?.taskScenes ?? {}).length > 0 ? ['task' as const] : []),
  ]
  const visibleSources = [
    ...(experiment?.scene && experimentVisible ? ['experiment' as const] : []),
    ...(Object.keys(experiment?.taskScenes ?? {}).length > 0 && taskVisible ? ['task' as const] : []),
  ]
  const visibleExperimentScenes = Object.entries(experiment?.taskScenes ?? {}).filter(
    ([name]) => activeExperimentTaskName === null || name === activeExperimentTaskName,
  )
  const lengthUnit = experiment?.scene?.lengthUnit ?? visibleExperimentScenes[0]?.[1].lengthUnit ?? 'm'
  const layers = [
    ...(experiment?.scene && experimentVisible
      ? [
          {
            source: 'experiment' as const,
            lengthUnit: experiment.scene.lengthUnit,
            parts: experiment.scene.parts,
            sceneHash: experiment.sceneHash ?? null,
          },
        ]
      : []),
    ...(experiment && taskVisible
      ? visibleExperimentScenes.map(([taskName, scene]) => ({
          source: 'task' as const,
          taskName,
          lengthUnit: scene.lengthUnit,
          parts: scene.parts,
          sceneHash: experiment.taskSceneHashes?.[taskName] ?? null,
        }))
      : []),
  ] satisfies JscadViewerLayer[]

  return {
    availableSources,
    emptyMessage:
      availableSources.length === 0
        ? 'No Experiment geometry is available.'
        : visibleSources.length === 0
          ? 'All Experiment geometry layers are hidden.'
          : 'Waiting for model...',
    layers,
    lengthUnit,
    visibleSources,
  }
}
