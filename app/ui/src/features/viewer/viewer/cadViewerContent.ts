import type { CadScene, Vars } from '@/lib/cad'
import type { JscadViewerLayer } from './sourceLayers'

export type CadViewerDocument = Readonly<{
  scene: CadScene | null
  sceneHash?: string | null
  variables: Readonly<Vars> | null
}>

export function resolveCadViewerContent(
  structure: CadViewerDocument | null,
  experiment: CadViewerDocument | null,
  structureVisible: boolean,
  experimentVisible: boolean,
) {
  const availableSources = [
    ...(structure ? ['structure' as const] : []),
    ...(experiment ? ['experiment' as const] : []),
  ]
  const visibleSources = [
    ...(structure && structureVisible ? ['structure' as const] : []),
    ...(experiment && experimentVisible ? ['experiment' as const] : []),
  ]
  const lengthUnit = structure?.scene?.lengthUnit ?? experiment?.scene?.lengthUnit ?? 'm'
  const layers = [
    ...(experiment && experimentVisible
      ? [
          {
            documentType: 'experiment' as const,
            lengthUnit: experiment.scene?.lengthUnit ?? lengthUnit,
            parts: experiment.scene?.parts ?? [],
            sceneHash: experiment.sceneHash ?? null,
          },
        ]
      : []),
    ...(structure && structureVisible
      ? [
          {
            documentType: 'structure' as const,
            lengthUnit: structure.scene?.lengthUnit ?? lengthUnit,
            parts: structure.scene?.parts ?? [],
            sceneHash: structure.sceneHash ?? null,
          },
        ]
      : []),
  ] satisfies JscadViewerLayer[]

  return {
    availableSources,
    emptyMessage:
      availableSources.length === 0
        ? 'No Structure or Experiment source is available.'
        : visibleSources.length === 0
          ? 'All Structure and Experiment sources are hidden.'
          : 'Waiting for model...',
    layers,
    lengthUnit,
    visibleSources,
  }
}
