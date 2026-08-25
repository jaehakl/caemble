import { convertUcumValue, type RayPathBundle, type UcumUnit } from '@/lib/cad'

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
  bundles: readonly RayPathBundle[],
  displayLengthUnit: UcumUnit,
): readonly RayPathRenderGeometry[] {
  const scale = convertUcumValue(1, 'm', displayLengthUnit, 'ray-path viewer lengthUnit')
  let maximumPower = 0
  bundles.forEach((bundle) => bundle.segmentPower.forEach((power) => (maximumPower = Math.max(maximumPower, power))))
  const geometries: RayPathRenderGeometry[] = []

  bundles.forEach((bundle) => {
    let firstPath = 0
    while (firstPath < bundle.pathCount) {
      let lastPath = firstPath
      const firstVertex = bundle.pathOffsets[firstPath]
      while (
        lastPath < bundle.pathCount &&
        bundle.pathOffsets[lastPath + 1] - firstVertex <= maximumVerticesPerGeometry
      ) {
        lastPath += 1
      }
      const lastVertex = bundle.pathOffsets[lastPath]
      const vertexCount = lastVertex - firstVertex
      const segmentCount = vertexCount - (lastPath - firstPath)
      const positions = new Float32Array(vertexCount * 3)
      const colors = new Float32Array(vertexCount * 4)
      const indices = new Uint16Array(segmentCount * 2)
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const source = (firstVertex + vertex) * 3
        const target = vertex * 3
        positions[target] = bundle.vertices[source] * scale
        positions[target + 1] = bundle.vertices[source + 1] * scale
        positions[target + 2] = bundle.vertices[source + 2] * scale
      }
      let indexOffset = 0
      for (let path = firstPath; path < lastPath; path += 1) {
        const pathFirstVertex = bundle.pathOffsets[path]
        const pathVertexCount = bundle.pathOffsets[path + 1] - pathFirstVertex
        const firstSegment = pathFirstVertex - path
        const rgb = wavelengthRgb(bundle.pathWavelength[path])
        for (let vertex = 0; vertex < pathVertexCount; vertex += 1) {
          const localVertex = pathFirstVertex - firstVertex + vertex
          const segment = firstSegment + Math.min(vertex, pathVertexCount - 2)
          const alpha = maximumPower > 0 ? Math.max(0.04, Math.sqrt(bundle.segmentPower[segment] / maximumPower)) : 0.04
          colors[localVertex * 4] = rgb[0]
          colors[localVertex * 4 + 1] = rgb[1]
          colors[localVertex * 4 + 2] = rgb[2]
          colors[localVertex * 4 + 3] = alpha
          if (vertex < pathVertexCount - 1) {
            indices[indexOffset] = localVertex
            indices[indexOffset + 1] = localVertex + 1
            indexOffset += 2
          }
        }
      }
      geometries.push(Object.freeze({ positions, colors, indices }))
      firstPath = lastPath
    }
  })
  return Object.freeze(geometries)
}
