import { transforms } from '@jscad/modeling'
import { convertUcumValue, type CadScenePart, type UcumUnit } from '@/lib/cad'
import { createRenderParts } from './renderParts'

export type CadViewerSource = 'experiment' | 'task'

export type JscadViewerLayer = Readonly<{
  source: CadViewerSource
  taskName?: string
  lengthUnit: UcumUnit
  parts: CadScenePart[]
  sceneHash?: string | null
}>

export function scaleViewerLayers(
  layers: readonly JscadViewerLayer[],
  displayLengthUnit: UcumUnit,
): readonly JscadViewerLayer[] {
  const scaleGeometry = transforms.scale as unknown as (
    factors: readonly [number, number, number],
    geometry: unknown,
  ) => unknown
  return layers.map((layer) => {
    const factor = convertUcumValue(1, layer.lengthUnit, displayLengthUnit, `${layer.source} viewer lengthUnit`)
    if (factor === 1) return layer
    return {
      ...layer,
      lengthUnit: displayLengthUnit,
      parts: layer.parts.map((part) => ({
        ...part,
        geometry: scaleGeometry([factor, factor, factor], part.geometry),
      })),
    }
  })
}

export function createLayerRenderParts(layers: readonly JscadViewerLayer[]) {
  return layers.flatMap((layer) => createRenderParts(layer.parts))
}
