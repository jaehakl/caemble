import { transforms } from '@jscad/modeling'
import { convertUcumValue, type UcumUnit } from '@/lib/cad/model'
import type { CadViewerSelectionMatch, JscadViewerLayer } from './model'
import { createRenderParts, type RenderPartSelection } from './renderParts'

export type { CadViewerSource, JscadViewerLayer } from './model'

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

export function createLayerRenderParts(
  layers: readonly JscadViewerLayer[],
  selectionMatches: readonly CadViewerSelectionMatch[] = [],
  xrayEnabled = false,
) {
  return layers.flatMap((layer) => {
    const selections = new Map<string, { geometry: boolean; polygonIndices: Set<number> }>()
    selectionMatches
      .filter(
        (match) =>
          match.source === layer.source && (match.source === 'experiment' || match.taskName === layer.taskName),
      )
      .forEach((match) => {
        const current = selections.get(match.geometryId) ?? { geometry: false, polygonIndices: new Set<number>() }
        if (!match.surfaceId) current.geometry = true
        else {
          layer.parts
            .find((part) => part.id === match.geometryId)
            ?.surfaces.find((surface) => surface.id === match.surfaceId)
            ?.polygonIndices.forEach((polygonIndex) => current.polygonIndices.add(polygonIndex))
        }
        selections.set(match.geometryId, current)
      })
    return createRenderParts(layer.parts, selections as ReadonlyMap<string, RenderPartSelection>, xrayEnabled)
  })
}
