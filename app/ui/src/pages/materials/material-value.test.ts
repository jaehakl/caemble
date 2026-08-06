import { describe, expect, it } from 'vitest'
import { materialParameterData } from '@/lib/material'
import {
  createMaterialPropertyValue,
  createMaterialRelationValue,
  getMaterialModel,
  getMaterialProperty,
  getQuantityValueConfig,
  readMaterialPropertyValue,
  readMaterialRelationValue,
} from './material-value'

function componentValue(shape: readonly number[], value = 1): number | readonly unknown[] {
  if (shape.length === 0) return value
  return Array.from({ length: shape[0] }, () => componentValue(shape.slice(1), value))
}

describe('Material structured values', () => {
  it('creates an exact property payload from the catalog Quantity Kind', () => {
    const definition = getMaterialProperty('general.mass_density')!
    const { shape, units } = getQuantityValueConfig(definition.quantity_kind)
    expect(shape).toEqual([])
    expect(units).toContain('kg.m-3')

    const value = createMaterialPropertyValue(definition, 'float32', 2700, 'kg.m-3')
    expect(value).toEqual({ dtype: 'float32', value: 2700, unit: 'kg.m-3' })
    expect(Object.keys(value)).toEqual(['dtype', 'value', 'unit'])
    expect(readMaterialPropertyValue(definition, value)).toEqual(value)
  })

  it('enforces dtype representation, tensor shape, exact keys, and applicable units', () => {
    const tensorDefinition = materialParameterData.find(
      (definition) => getQuantityValueConfig(definition.quantity_kind).shape.length > 0,
    )!
    const { shape, units } = getQuantityValueConfig(tensorDefinition.quantity_kind)
    const tensor = componentValue(shape)

    expect(createMaterialPropertyValue(tensorDefinition, 'float16', tensor, units[0])).toEqual({
      dtype: 'float16',
      value: tensor,
      unit: units[0],
    })
    expect(() => createMaterialPropertyValue(tensorDefinition, 'float32', 1, units[0])).toThrow('expected shape')
    expect(() =>
      createMaterialPropertyValue(tensorDefinition, 'float16', componentValue(shape, 70_000), units[0]),
    ).toThrow('float16')
    expect(() => createMaterialPropertyValue(tensorDefinition, 'float32', tensor, 'invalid-unit')).toThrow(
      '사용할 수 없습니다',
    )
    expect(
      readMaterialPropertyValue(tensorDefinition, {
        dtype: 'float32',
        value: tensor,
        unit: units[0],
        errorRate: 0,
      }),
    ).toBeNull()
  })

  it('creates and restores the existing sampled-relation contract', () => {
    const definition = getMaterialModel('model.magnetic_hysteresis.b_h_curve')!
    const inputConfig = getQuantityValueConfig(definition.input.quantity_kind)
    const outputConfig = getQuantityValueConfig(definition.output.quantity_kind)
    const inputValues = [componentValue(inputConfig.shape, 1), componentValue(inputConfig.shape, 2)]
    const outputValues = [componentValue(outputConfig.shape, 3), componentValue(outputConfig.shape, 4)]

    const value = createMaterialRelationValue(
      definition,
      inputConfig.units[0],
      outputConfig.units[0],
      inputValues,
      outputValues,
    )
    expect(value).toEqual({
      kind: 'sampled_relation',
      input: { unit: inputConfig.units[0], values: inputValues },
      output: { unit: outputConfig.units[0], values: outputValues },
    })
    expect(readMaterialRelationValue(definition, value)).toEqual(value)
    expect(() =>
      createMaterialRelationValue(
        definition,
        inputConfig.units[0],
        outputConfig.units[0],
        inputValues.slice(0, 1),
        outputValues.slice(0, 1),
      ),
    ).toThrow('at least 2 samples')
    expect(
      readMaterialRelationValue(definition, {
        ...value,
        input: {
          ...value.input,
          basis: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        },
      }),
    ).toBeNull()
  })
})
