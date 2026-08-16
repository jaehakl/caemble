import { beforeEach, describe, expect, it } from 'vitest'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import { identityCartesianBasis } from '../quantitykind/identityBasis'
import {
  QuantityKindEntry,
  componentShapeForTensorOrder,
  transformQuantityComponents,
  transformQuantityValue,
} from '../quantitykind/runtime'
import { installCatalogRuntimeSlice } from './runtime'

const slice = {
  schemaVersion: 1,
  catalogRevision: 'synthetic-test',
  solvers: [],
  quantityKinds: [
    { name: 'Length', domain: 'synthetic', tensorOrder: 0, description: 'Length', opaque: false, applicableUnits: ['mm', 'm'] },
    { name: 'Temperature', domain: 'synthetic', tensorOrder: 0, description: 'Temperature', opaque: false, applicableUnits: ['Cel', 'K'] },
    { name: 'LogRatio', domain: 'synthetic', tensorOrder: 0, description: 'Opaque ratio', opaque: true, applicableUnits: ['B.m-1', 'dB.m-1'] },
    ...[1, 2, 3, 4].map((tensorOrder) => ({
      name: `Tensor${tensorOrder}`, domain: 'synthetic', tensorOrder, description: `Rank ${tensorOrder}`,
      opaque: false, applicableUnits: ['N', 'kN'],
    })),
  ],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: [],
  warnings: [],
} satisfies CatalogRuntimeSlice

function zeroTensor(order: number): unknown {
  return order === 0 ? 0 : Array.from({ length: 3 }, () => zeroTensor(order - 1))
}

function axisTensor(order: number): unknown {
  return order === 0 ? 1 : [axisTensor(order - 1), zeroTensor(order - 1), zeroTensor(order - 1)]
}

describe('runtime catalog immutability', () => {
  beforeEach(() => installCatalogRuntimeSlice(slice))

  it('deep-freezes a structured-cloned slice before user code can access it', () => {
    const exposed = new QuantityKindEntry('Length').applicableUnits()

    expect(Object.isFrozen(slice.quantityKinds)).toBe(true)
    expect(Object.isFrozen(slice.quantityKinds[0].applicableUnits)).toBe(true)
    expect(Object.isFrozen(exposed)).toBe(true)
    expect(() => (exposed as string[]).push('cm')).toThrow()
    expect(new QuantityKindEntry('Length').applicableUnits()).toEqual(['mm', 'm'])
  })

  it('converts linear and affine scalar units and enforces opaque identity conversion', () => {
    expect(new QuantityKindEntry('Length').transform(1_000, 'mm', 'm')).toBeCloseTo(1)
    expect(new QuantityKindEntry('Temperature').transform(0, 'Cel', 'K')).toBeCloseTo(273.15)
    expect(new QuantityKindEntry('LogRatio').transform(2, 'B.m-1', 'B.m-1')).toBe(2)
    expect(() => new QuantityKindEntry('LogRatio').transform(2, 'B.m-1', 'dB.m-1')).toThrow(
      'does not support unit conversion',
    )
  })

  it('recursively converts vector and matrix components and rejects affine tensor conversion', () => {
    expect(transformQuantityComponents([1, 2, 3], [3], 'N', 'kN', 'Vector')).toEqual([0.001, 0.002, 0.003])
    const matrix = transformQuantityComponents(
      [[1, 0, 0], [0, 2, 0], [0, 0, 3]], [3, 3], 'N', 'kN', 'Matrix',
    ) as readonly (readonly number[])[]
    expect(matrix.flat()).toEqual([0.001, 0, 0, 0, 0.002, 0, 0, 0, 0.003])
    expect(Object.isFrozen(matrix[0])).toBe(true)
    expect(() => transformQuantityComponents([0, 0, 0], [3], 'Cel', 'K', 'Affine tensor')).toThrow(
      'zero-preserving unit transform',
    )
  })

  it('rotates rank-1 through rank-4 tensors and reverses the basis transform', () => {
    const rotatedBasis = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] as const
    for (let order = 1; order <= 4; order += 1) {
      const source = axisTensor(order)
      const shape = new QuantityKindEntry(`Tensor${order}`).componentShape()
      const transformed = transformQuantityValue(
        source, shape, { unit: 'N', basis: identityCartesianBasis }, { unit: 'kN', basis: rotatedBasis },
      ) as readonly unknown[]
      let component: unknown = transformed
      for (let depth = 0; depth < order; depth += 1) component = (component as readonly unknown[])[1]
      expect(component).toBeCloseTo((order % 2 === 0 ? 1 : -1) * 0.001)
      expect(
        transformQuantityValue(
          transformed, componentShapeForTensorOrder(order),
          { unit: 'kN', basis: rotatedBasis }, { unit: 'N', basis: identityCartesianBasis },
        ),
      ).toEqual(source)
      expect(Object.isFrozen(transformed)).toBe(true)
    }
  })

  it('rejects non-finite values and units outside the selected slice', () => {
    const length = new QuantityKindEntry('Length')
    expect(() => length.transform(Number.NaN, 'mm', 'm')).toThrow('finite tensor component')
    expect(() => length.transform(1, 's', 'm')).toThrow('does not include source UCUM unit s')
    expect(() => length.transform(1, 'm', 's')).toThrow('does not include target UCUM unit s')
  })
})
