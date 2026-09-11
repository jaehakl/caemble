import { convertUcumValue, type PolylineBundle, type UcumUnit } from '@/lib/cad/model'

export type RayPathRenderGeometry = Readonly<{
  positions: Float32Array
  colors: Float32Array
  indices: Uint16Array
}>

const maximumVerticesPerGeometry = 65_535

function wavelengthRgb(wavelengthMeters: number): readonly [number, number, number] {
  const wavelength = wavelengthMeters * 1e9
  if (wavelength < 380) return [0.55, 0.2, 1]
  if (wavelength < 440) return [(440 - wavelength) / 60, 0, 1]
  if (wavelength < 490) return [0, (wavelength - 440) / 50, 1]
  if (wavelength < 510) return [0, 1, (510 - wavelength) / 20]
  if (wavelength < 580) return [(wavelength - 510) / 70, 1, 0]
  if (wavelength < 645) return [1, (645 - wavelength) / 65, 0]
  if (wavelength <= 780) return [1, 0, 0]
  return [1, 0.15, 0.15]
}

export function createRayPathRenderGeometries(
  bundles: readonly PolylineBundle[],
  displayLengthUnit: UcumUnit,
): readonly RayPathRenderGeometry[] {
  const scale = convertUcumValue(1, 'm', displayLengthUnit, 'ray-path viewer lengthUnit')
  let maximumPower = 0
  bundles.forEach((bundle) => bundle.segmentPower.forEach((power) => (maximumPower = Math.max(maximumPower, power))))
  const geometries: RayPathRenderGeometry[] = []

  bundles.forEach((bundle) => {
    let positions: number[] = [],
      colors: number[] = [],
      indices: number[] = []
    for (let path = 0; path < bundle.pathCount; path++) {
      const rgb = wavelengthRgb(bundle.pathWavelength[path])
      for (let vertex = bundle.pathOffsets[path]; vertex < bundle.pathOffsets[path + 1] - 1; vertex++) {
        const segment = vertex - path
        const alpha =
          maximumPower > 0 ? Math.max(0.04, Math.sqrt(Math.max(0, bundle.segmentPower[segment]) / maximumPower)) : 0.04
        const first = positions.length / 3
        for (const point of [vertex, vertex + 1]) {
          positions.push(
            bundle.vertices[point * 3] * scale,
            bundle.vertices[point * 3 + 1] * scale,
            bundle.vertices[point * 3 + 2] * scale,
          )
          colors.push(...rgb, alpha)
        }
        indices.push(first, first + 1)
        if (positions.length / 3 + 2 > maximumVerticesPerGeometry) {
          geometries.push({
            positions: Float32Array.from(positions),
            colors: Float32Array.from(colors),
            indices: Uint16Array.from(indices),
          })
          positions = []
          colors = []
          indices = []
        }
      }
    }
    if (indices.length)
      geometries.push({
        positions: Float32Array.from(positions),
        colors: Float32Array.from(colors),
        indices: Uint16Array.from(indices),
      })
  })
  return Object.freeze(geometries)
}
