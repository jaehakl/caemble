import { describe, expect, it } from 'vitest'
import { materialTestCatalog } from './material-test-fixtures'
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
    const definition = getMaterialProperty('test.scalar_property', materialTestCatalog)!
    const { shape, units } = getQuantityValueConfig(definition.quantity_kind, materialTestCatalog)
    expect(shape).toEqual([])
    expect(units).toContain('{test-scalar}')

    const value = createMaterialPropertyValue(definition, 'float32', 2700, '{test-scalar}', materialTestCatalog)
    expect(value).toEqual({ dtype: 'float32', value: 2700, unit: '{test-scalar}' })
    expect(Object.keys(value)).toEqual(['dtype', 'value', 'unit'])
    expect(readMaterialPropertyValue(definition, value, materialTestCatalog)).toEqual(value)
  })

  it('enforces dtype representation, tensor shape, exact keys, and applicable units', () => {
    const tensorDefinition = getMaterialProperty('test.matrix_property', materialTestCatalog)!
    const { shape, units } = getQuantityValueConfig(tensorDefinition.quantity_kind, materialTestCatalog)
    const tensor = componentValue(shape)

    expect(createMaterialPropertyValue(tensorDefinition, 'float16', tensor, units[0], materialTestCatalog)).toEqual({
      dtype: 'float16',
      value: tensor,
      unit: units[0],
    })
    expect(() => createMaterialPropertyValue(tensorDefinition, 'float32', 1, units[0], materialTestCatalog)).toThrow(
      'expected shape',
    )
    expect(() =>
      createMaterialPropertyValue(
        tensorDefinition,
        'float16',
        componentValue(shape, 70_000),
        units[0],
        materialTestCatalog,
      ),
    ).toThrow('float16')
    expect(() =>
      createMaterialPropertyValue(tensorDefinition, 'float32', tensor, 'invalid-unit', materialTestCatalog),
    ).toThrow('사용할 수 없습니다')
    expect(
      readMaterialPropertyValue(
        tensorDefinition,
        {
          dtype: 'float32',
          value: tensor,
          unit: units[0],
          errorRate: 0,
        },
        materialTestCatalog,
      ),
    ).toBeNull()
  })

  it('creates and restores the existing sampled-relation contract', () => {
    const definition = getMaterialModel('model.test.vector_curve', materialTestCatalog)!
    const inputConfig = getQuantityValueConfig(definition.input.quantity_kind, materialTestCatalog)
    const outputConfig = getQuantityValueConfig(definition.output.quantity_kind, materialTestCatalog)
    const inputValues = [componentValue(inputConfig.shape, 1), componentValue(inputConfig.shape, 2)]
    const outputValues = [componentValue(outputConfig.shape, 3), componentValue(outputConfig.shape, 4)]

    const value = createMaterialRelationValue(
      definition,
      inputConfig.units[0],
      outputConfig.units[0],
      inputValues,
      outputValues,
      materialTestCatalog,
    )
    expect(value).toEqual({
      kind: 'sampled_relation',
      input: { unit: inputConfig.units[0], values: inputValues },
      output: { unit: outputConfig.units[0], values: outputValues },
    })
    expect(readMaterialRelationValue(definition, value, materialTestCatalog)).toEqual(value)
    expect(() =>
      createMaterialRelationValue(
        definition,
        inputConfig.units[0],
        outputConfig.units[0],
        inputValues.slice(0, 1),
        outputValues.slice(0, 1),
        materialTestCatalog,
      ),
    ).toThrow('at least 2 samples')
    expect(
      readMaterialRelationValue(
        definition,
        {
          ...value,
          input: {
            ...value.input,
            basis: [
              [1, 0, 0],
              [0, 1, 0],
              [0, 0, 1],
            ],
          },
        },
        materialTestCatalog,
      ),
    ).toBeNull()
  })
})
