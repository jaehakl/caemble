import { booleans, primitives, transforms } from '@jscad/modeling'
import { describe, expect, it } from 'vitest'
import type { CadScenePart } from '@/lib/cad'
import { createMaterialGrid } from './materialGrid'

function createPart(
  id: string,
  geometry: unknown,
  materialSymbol: string | null = 'Core',
  color: string | null = '#2563eb',
): CadScenePart {
  return {
    id,
    geometry,
    ...(materialSymbol === null
      ? {}
      : { material: { name: materialSymbol, variables: color === null ? {} : { color } } }),
    surfaces: [],
  }
}

function readPoints(positions: Float32Array) {
  const points: number[][] = []
  for (let index = 0; index < positions.length; index += 3) {
    points.push([positions[index], positions[index + 1], positions[index + 2]])
  }
  return points
}

describe('Material Grid generation', () => {
  it('keeps world-origin Grid points that are inside or on a geometry boundary', () => {
    const geometry = transforms.translate([0.4, 0.4, 0.4], primitives.cuboid({ size: [1, 1, 1] }))
    const result = createMaterialGrid([createPart('sample.core', geometry)], 0.5)

    expect(result.candidatePointCount).toBe(8)
    expect(result.visiblePointCount).toBe(8)
    expect(readPoints(result.positions)).toEqual([
      [0, 0, 0],
      [0, 0, 0.5],
      [0, 0.5, 0],
      [0, 0.5, 0.5],
      [0.5, 0, 0],
      [0.5, 0, 0.5],
      [0.5, 0.5, 0],
      [0.5, 0.5, 0.5],
    ])
  })

  it('applies geometry transforms and omits Grid points outside the solid', () => {
    const geometry = transforms.translate(
      [3, 0, 0],
      transforms.rotateZ(Math.PI / 2, primitives.cuboid({ size: [4, 2, 2] })),
    )
    const result = createMaterialGrid([createPart('sample.core', geometry)], 1)
    const points = readPoints(result.positions)

    expect(points).toContainEqual([3, 2, 0])
    expect(points).not.toContainEqual([5, 0, 0])
    expect(points.every((point) => point.every(Number.isInteger))).toBe(true)
  })

  it('does not fill the void inside a hollow geometry', () => {
    const geometry = booleans.subtract(primitives.cuboid({ size: [6, 6, 6] }), primitives.cuboid({ size: [4, 4, 4] }))
    const result = createMaterialGrid([createPart('sample.shell', geometry)], 1)
    const points = readPoints(result.positions)

    expect(result.candidatePointCount).toBe(343)
    expect(result.visiblePointCount).toBe(316)
    expect(points).not.toContainEqual([0, 0, 0])
    expect(points).toContainEqual([2, 0, 0])
    expect(points).toContainEqual([3, 0, 0])
  })

  it('uses the later scene Geometry material when solids overlap', () => {
    const geometry = primitives.cuboid({ size: [2, 2, 2] })
    const result = createMaterialGrid(
      [
        createPart('sample.core', geometry, 'Core', '#2563eb'),
        createPart('sample.cladding', geometry, 'Cladding', '#f59e0b'),
      ],
      1,
    )

    expect(result.visiblePointCount).toBe(27)
    for (let index = 0; index < result.colors.length; index += 4) {
      expect(result.colors[index]).toBeCloseTo(245 / 255)
      expect(result.colors[index + 1]).toBeCloseTo(158 / 255)
      expect(result.colors[index + 2]).toBeCloseTo(11 / 255)
      expect(result.colors[index + 3]).toBe(1)
    }
  })

  it('excludes colorless and materialless Geometry from Grid points', () => {
    const geometry = primitives.cuboid({ size: [2, 2, 2] })
    const result = createMaterialGrid(
      [createPart('sample.colorless', geometry, 'Core', null), createPart('sample.materialless', geometry, null)],
      1,
    )

    expect(result.candidatePointCount).toBe(0)
    expect(result.visiblePointCount).toBe(0)
    expect(result.colors).toHaveLength(0)
  })

  it('does not let later unassigned Geometry hide colored Grid points', () => {
    const geometry = primitives.cuboid({ size: [2, 2, 2] })
    const result = createMaterialGrid(
      [
        createPart('sample.core', geometry, 'Core', '#2563eb'),
        createPart('sample.colorless', geometry, 'Colorless', null),
        createPart('sample.materialless', geometry, null),
      ],
      1,
    )

    expect(result.visiblePointCount).toBe(27)
    for (let index = 0; index < result.colors.length; index += 4) {
      expect(result.colors[index]).toBeCloseTo(37 / 255)
      expect(result.colors[index + 1]).toBeCloseTo(99 / 255)
      expect(result.colors[index + 2]).toBeCloseTo(235 / 255)
      expect(result.colors[index + 3]).toBe(1)
    }
  })

  it('automatically increases spacing to stay at or below 100,000 candidates', () => {
    const geometry = primitives.cuboid({ size: [50, 50, 50] })
    const result = createMaterialGrid([createPart('sample.core', geometry)], 1)

    expect(result.effectiveSpacing).toBeGreaterThan(1)
    expect(result.candidatePointCount).toBeLessThanOrEqual(100_000)
    expect(result.visiblePointCount).toBe(result.candidatePointCount)
  })

  it('rejects invalid spacing values', () => {
    const part = createPart('sample.core', primitives.cube())

    expect(() => createMaterialGrid([part], 0)).toThrow('positive finite number')
    expect(() => createMaterialGrid([part], Number.NaN)).toThrow('positive finite number')
  })
})
