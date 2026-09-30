import { describe, expect, it } from 'vitest'
import type { OptimizationAxis } from '@/contracts/api/optimization'
import { optimizationAxes, optimizationVariables, validateOptimizationAxes } from './variables'

describe('optimization variables', () => {
  const scalarSchema = { width: { shape: [], min: 0, max: 10 } }
  const scalarAxis: OptimizationAxis = { name: 'width', indices: [], min: 0, max: 10, fixed: false }

  it.each([
    { shape: [], min: NaN, max: 10 },
    { shape: [], min: 0, max: Infinity },
    { shape: [], min: 10, max: 0 },
    { shape: [-1], min: 0, max: 10 },
    { shape: [0], min: 0, max: 10 },
    { shape: [1.5], min: 0, max: 10 },
    { shape: [Infinity], min: 0, max: 10 },
    { shape: [1, 1, 1], min: 0, max: 10 },
    { shape: [Number.MAX_SAFE_INTEGER, 2], min: 0, max: 10 },
  ])('rejects invalid source schemas before rendering search axes: %j', (entry) => {
    const schema = { width: entry }
    expect(() => optimizationAxes(schema)).toThrow(/Vars/)
    expect(() => optimizationVariables({ width: 2 }, schema)).toThrow(/Vars/)
    expect(() => validateOptimizationAxes([scalarAxis], { width: 2 }, schema)).toThrow(/Vars/)
  })

  it.each([NaN, Infinity, -Infinity])('rejects non-finite candidate values: %s', (width) => {
    expect(() => optimizationVariables({ width }, scalarSchema)).toThrow(/non-finite/)
    expect(() => validateOptimizationAxes([scalarAxis], { width }, scalarSchema)).toThrow(/현재 값/)
  })

  it('rejects stale names and missing tensor elements before creating a snapshot', () => {
    expect(() => optimizationVariables({ oldWidth: 2 }, scalarSchema)).toThrow(/일치하지/)
    const vector = new Array<number>(3)
    vector[0] = 1
    vector[2] = 2
    expect(() => optimizationVariables({ vector }, { vector: { shape: [3], min: 0, max: 10 } })).toThrow(
      /모든 변수 원소/,
    )
  })

  it.each([
    { name: 'oldWidth', indices: [] },
    { name: 'width', indices: [0] },
    { name: 'vector', indices: [] },
    { name: 'vector', indices: [-1] },
    { name: 'vector', indices: [2] },
    { name: 'vector', indices: [0.5] },
    { name: 'vector', indices: [NaN] },
  ])('rejects axes outside the current schema without indexing invalid values: %j', (axis) => {
    const schema = { ...scalarSchema, vector: { shape: [2], min: 0, max: 10 } }
    expect(() => validateOptimizationAxes([{ ...scalarAxis, ...axis }], { width: 2, vector: [3, 4] }, schema)).toThrow(
      /현재 Vars/,
    )
  })

  it('rejects duplicate axes and reports missing nested values as a validation error', () => {
    expect(() => validateOptimizationAxes([scalarAxis, scalarAxis], { width: 2 }, scalarSchema)).toThrow(/중복/)
    expect(() =>
      validateOptimizationAxes(
        [{ ...scalarAxis, name: 'matrix', indices: [0, 0] }],
        {},
        { matrix: { shape: [1, 1], min: 0, max: 10 } },
      ),
    ).toThrow(/현재 값/)
  })

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
