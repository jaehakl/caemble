import { expect, expectTypeOf, it } from 'vitest'
import { experiment, type VarsSchemaDefinition } from './definition'

it('preserves scalar shorthand and infers scalar, vector and matrix values', () => {
  const definition = experiment({
    lengthUnit: 'mm',
    varsSchema: {
      scalar: { min: 0, max: 1 },
      explicit: { shape: [], min: 0, max: 1 },
      vector: { shape: [3], min: 0, max: 1 },
      particles: { shape: [13, 4], min: 0, max: 1 },
    },
    geometry: ({ vars }) => {
      expectTypeOf(vars.scalar).toEqualTypeOf<number>()
      expectTypeOf(vars.explicit).toEqualTypeOf<number>()
      expectTypeOf(vars.vector).toEqualTypeOf<readonly [number, number, number]>()
      expectTypeOf(vars.particles[0]).toEqualTypeOf<readonly [number, number, number, number]>()
      return vars.particles
    },
    recordedData: {},
  })
  expect(definition.varsSchema.scalar.shape).toEqual([])
  expect(definition.varsSchema.explicit.shape).toEqual([])
  expect(definition.varsSchema.vector.shape).toEqual([3])
  expect(definition.varsSchema.particles.shape).toEqual([13, 4])
  expect(Object.isFrozen(definition.varsSchema.particles.shape)).toBe(true)
})

it.each([
  [1, 1, 1],
  [2, 3, 4],
  [1, 1, 1, 1],
])('rejects higher rank schemas even when type checking is bypassed: %j', (...shape) => {
  expect(() =>
    experiment({
      lengthUnit: 'mm',
      varsSchema: { volume: { shape, min: 0, max: 1 } } as unknown as VarsSchemaDefinition,
      geometry: () => null,
      recordedData: {},
    }),
  ).toThrow(`varsSchema.volume.shape supports at most 2 dimensions; received ${shape.length}.`)
})
