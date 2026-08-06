import { primitives } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import type { CadScenePart } from '@/lib/cad'
import { createRenderParts, createWireframeGeometries } from './renderParts'

function createPart(id = 'assembly.core', color: string | null = '#2563eb', withMaterial = true): CadScenePart {
  return {
    id,
    geometry: primitives.cuboid({ size: [2, 2, 2] }),
    ...(withMaterial ? { material: { name: 'Core', variables: color === null ? {} : { color } } } : {}),
    surfaces: [
      { id: `${id}/surface-1`, name: '-X', polygonIndices: [0] },
      { id: `${id}/surface-2`, name: 'Other', polygonIndices: [1, 2, 3, 4, 5] },
    ],
  }
}

describe('viewer render parts', () => {
  it('keeps original geometry and Material color', () => {
    const part = createPart()
    const [renderPart] = createRenderParts([part])

    expect(renderPart.geometry).toBe(part.geometry)
    expect(renderPart.color).toEqual([37 / 255, 99 / 255, 235 / 255, 1])
    expect(renderPart.wireframe).toBe(false)
  })

  it('uses neutral wireframe rendering when Material or color is missing', () => {
    const rendered = createRenderParts([createPart('colorless', null), createPart('materialless', null, false)])

    for (const renderPart of rendered) {
      expect(renderPart.color).toEqual([71 / 255, 85 / 255, 105 / 255, 1])
      expect(renderPart.wireframe).toBe(true)
      const [wireframe] = createWireframeGeometries(renderPart)
      expect(wireframe.positions).toHaveLength(24)
      expect(wireframe.indices).toHaveLength(24)
      expect(wireframe.colors.every((color) => color === renderPart.color)).toBe(true)
    }
  })

  it('keeps every unique polygon edge', () => {
    const transforms = (primitives.cuboid() as { transforms: unknown }).transforms
    const part: CadScenePart = {
      id: 'wireframe',
      geometry: {
        transforms,
        polygons: [
          {
            vertices: [
              [0, 0, 0],
              [1, 0, 0],
              [1, 1, 0],
            ],
          },
          {
            vertices: [
              [0, 0, 0],
              [1, 1, 0],
              [0, 1, 0],
            ],
          },
        ],
      },
      material: { name: 'Colorless', variables: {} },
      surfaces: [],
    }
    const [wireframe] = createWireframeGeometries(createRenderParts([part])[0])

    expect(wireframe.positions).toHaveLength(10)
    expect(wireframe.colors.every((color) => color === wireframe.colors[0])).toBe(true)
  })

  it('splits large wireframes below the 16-bit vertex limit', () => {
    const transforms = (primitives.cuboid() as { transforms: unknown }).transforms
    const vertexCount = 32_768
    const vertices = Array.from({ length: vertexCount }, (_, index) => {
      const angle = (index / vertexCount) * Math.PI * 2
      return [Math.cos(angle), Math.sin(angle), 0]
    })
    const part = createPart('large-wireframe', null, false)
    part.geometry = { transforms, polygons: [{ vertices }] }
    const geometries = createWireframeGeometries(createRenderParts([part])[0])

    expect(geometries.map((geometry) => geometry.positions.length)).toEqual([65_534, 2])
    expect(geometries.every((geometry) => geometry.indices[geometry.indices.length - 1] <= 65_534)).toBe(true)
  })
})
