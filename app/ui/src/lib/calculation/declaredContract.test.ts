import { describe, expect, it } from 'vitest'
import { assertDeclaredTensor, extractCalculationContract } from './declaredContract'

const contract = { version: 1, inputs: {}, output: { dtype: 'float64', shape: [] } }
const source = (value: unknown, body = 'return { dtype: "float64", data: 1 }') =>
  `/* @caemble-contract ${JSON.stringify(value)} */\nexport default function calculate(input) { ${body} }`

describe('code-declared Calculation contracts', () => {
  it('extracts without executing and supports legacy code', () => {
    expect(extractCalculationContract(source(contract, 'throw new Error("must not run")'))).toEqual(contract)
    expect(extractCalculationContract('export default function calculate(input) {}')).toBeNull()
  })
  it('requires a single leading valid declaration and matching dependencies', () => {
    expect(() => extractCalculationContract(source(contract) + '/* @caemble-contract {} */')).toThrow()
    expect(() =>
      extractCalculationContract('export default function calculate(input) {}\n/* @caemble-contract {} */'),
    ).toThrow()
    expect(() => extractCalculationContract(source(contract, 'return input.field.data'))).toThrow(/dependencies/)
    expect(() => extractCalculationContract(source({ ...contract, extra: true }))).toThrow()
  })
  it('validates fixed and dynamic shapes, axes, units and numerical bounds', () => {
    const declaration = {
      dtype: 'float64' as const,
      shape: [null, 2],
      axes: [{ name: 'x', unit: 'm' }, {}],
      min: 0,
      max: 2,
    }
    const tensor = { dtype: 'float64', shape: [1, 2], axes: [{ name: 'x', unit: 'm' }, { name: 'y' }], data: [1, 2] }
    expect(() => assertDeclaredTensor(declaration, tensor)).not.toThrow()
    expect(() => assertDeclaredTensor(declaration, { ...tensor, shape: [1, 3] })).toThrow(/shape/)
    expect(() => assertDeclaredTensor(declaration, { ...tensor, data: [-1, 2] })).toThrow(/bounds/)
    expect(() =>
      assertDeclaredTensor(declaration, { ...tensor, axes: [{ name: 'x', unit: 'K' }, { name: 'y' }] }),
    ).toThrow(/axes/)
    expect(() =>
      extractCalculationContract(source({ ...contract, inputs: { field: { dtype: 'float64', shape: [null] } } })),
    ).toThrow()
  })
})
