import { primitives } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import type { CadScenePart } from '@/lib/cad'
import { automaticMaterialColor } from './materialColor'
import { colorFromHex, createRenderParts, createWireframeGeometries } from './renderParts'

function createPart(id = 'assembly.core', color: string | null = '#2563eb', withMaterial = true): CadScenePart {
  return {
    id,
    geometry: primitives.cuboid({ size: [2, 2, 2] }),
    materialRole: id,
    ...(withMaterial ? { material: { name: 'Core', variables: color === null ? {} : { color } } } : {}),
    surfaces: [
      { id: `${id}/surface/0`, surfaceIndex: 0, label: 'Local -X', polygonIndices: [0] },
      { id: `${id}/surface/1`, surfaceIndex: 1, label: 'Other', polygonIndices: [1, 2, 3, 4, 5] },
    ],
  }
}

describe('viewer render parts', () => {
  it('hashes UTF-8 Material roles into stable lower-case HSL-derived hex colors', () => {
    expect(automaticMaterialColor('wheel')).toBe('#4bb2d8')
    expect(automaticMaterialColor('shell')).toBe('#3e66e0')
    expect(automaticMaterialColor('타이어')).toBe('#701ae0')
  })

  it('keeps original geometry and Material color', () => {
    const part = createPart()
    const [renderPart] = createRenderParts([part])

    expect(renderPart.geometry).toBe(part.geometry)
    expect(renderPart.color).toEqual([37 / 255, 99 / 255, 235 / 255, 1])
    expect(renderPart.wireframe).toBe(false)
  })

  it('uses deterministic role colors when Material or color is missing', () => {
    const rendered = createRenderParts([createPart('colorless', null), createPart('materialless', null, false)])

    expect(rendered.map((part) => part.color)).toEqual([
      colorFromHex(automaticMaterialColor('colorless')),
      colorFromHex(automaticMaterialColor('materialless')),
    ])
    expect(rendered.every((part) => !part.wireframe)).toBe(true)
    expect(rendered[0].color).not.toEqual(rendered[1].color)
  })

  it('falls back to neutral wireframe only when both color and role are absent', () => {
    const roleless = {
      ...createPart('legacy', null, false),
      materialRole: undefined,
    } as unknown as CadScenePart
    const explicit = {
      ...createPart('legacy-colored'),
      materialRole: undefined,
    } as unknown as CadScenePart

    const [fallback, colored] = createRenderParts([roleless, explicit])

    expect(fallback.color).toEqual([71 / 255, 85 / 255, 105 / 255, 1])
    expect(fallback.wireframe).toBe(true)
    expect(colored.color).toEqual([37 / 255, 99 / 255, 235 / 255, 1])
    expect(colored.wireframe).toBe(false)
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
      materialRole: 'wireframe',
      material: { name: 'Colorless', variables: {} },
      surfaces: [],
    }
    const [wireframe] = createWireframeGeometries({
      color: [0.25, 0.5, 0.75, 1],
      geometry: part.geometry,
      wireframe: true,
    })

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
    const geometries = createWireframeGeometries({
      color: [0.25, 0.5, 0.75, 1],
      geometry: part.geometry,
      wireframe: true,
    })

    expect(geometries.map((geometry) => geometry.positions.length)).toEqual([65_534, 2])
    expect(geometries.every((geometry) => geometry.indices[geometry.indices.length - 1] <= 65_534)).toBe(true)
  })
})
