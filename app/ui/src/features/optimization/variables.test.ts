import { describe, expect, it } from 'vitest'
import { optimizationAxes, optimizationVariables, validateOptimizationAxes } from './variables'

describe('optimization variables', () => {
  it('includes every scalar, vector and matrix element while retaining fixed schema values', () => {
    const schema = {
      scalar: { shape: [], min: 0, max: 10 },
      vector: { shape: [2], min: 0, max: 10 },
      matrix: { shape: [2, 2], min: 0, max: 10 },
      fixed: { shape: [], min: 7, max: 7 },
    }
    const variables = {
      scalar: 1,
      vector: [2, 3],
      matrix: [
        [4, 5],
        [6, 7],
      ],
      fixed: 7,
    }
    const axes = optimizationAxes(schema)
    expect(axes.map(({ name, indices, fixed }) => [name, indices, fixed])).toEqual([
      ['scalar', [], false],
      ['vector', [0], false],
      ['vector', [1], false],
      ['matrix', [0, 0], false],
      ['matrix', [0, 1], false],
      ['matrix', [1, 0], false],
      ['matrix', [1, 1], false],
      ['fixed', [], true],
    ])
    const narrowed = axes.map((axis) =>
      axis.name === 'vector' ? { ...axis, min: 1, max: 4, fixed: axis.indices[0] === 1 } : axis,
    )
    expect(() => validateOptimizationAxes(narrowed, variables, schema)).not.toThrow()
    expect(() =>
      validateOptimizationAxes(
        axes.map((axis) => ({ ...axis, fixed: true })),
        variables,
        schema,
      ),
    ).not.toThrow()
    expect(() =>
      validateOptimizationAxes(
        axes.map((axis) => (axis.name === 'scalar' ? { ...axis, min: 1, max: 1 } : axis)),
        variables,
        schema,
      ),
    ).not.toThrow()
    expect(() =>
      validateOptimizationAxes(
        axes.map((axis) => (axis.name === 'scalar' ? { ...axis, min: 2, fixed: true } : axis)),
        variables,
        schema,
      ),
    ).toThrow(/현재 값/)
    const snapshot = optimizationVariables(variables, schema)
    variables.matrix[0][0] = 9
    expect(snapshot.matrix).toEqual([
      [4, 5],
      [6, 7],
    ])
    expect(() =>
      validateOptimizationAxes(
        axes.map((axis) => ({ ...axis, min: 8 })),
        variables,
        schema,
      ),
    ).toThrow(/현재 값/)
  })
})
