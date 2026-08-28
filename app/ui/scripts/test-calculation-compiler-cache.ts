import assert from 'node:assert/strict'
import { calculationMonacoStubState } from './calculation-monaco-stub'
import { compileCalculationSource } from '../src/lib/calculation/compiler'
import { CALCULATION_SOURCE_SKELETON } from '../src/lib/calculation/declarations'
import { calculationIndex } from '../src/lib/calculation/indexGuard'
import { CALCULATION_MATHJS_RUNTIME } from '../src/lib/calculation/mathRuntime'
import { CALCULATION_INDEX_GUARD_GLOBAL } from '../src/lib/calculation/runtimeGlobals'
import {
  CalculationExecutionError,
  type CalculationInput,
  type CalculationInputAxis,
  type CalculationInputLeaf,
  type CompiledCalculationSource,
} from '../src/lib/calculation/types'
import { assertCalculationInput, normalizeCalculationOutput } from '../src/lib/calculation/validation'

function sourceWithValue(value: number) {
  return `import { number as module } from 'mathjs'
export default function calculate(input) {
  void input
  return { dtype: 'float64', data: module(${value}) }
}`
}

function calculationInput(
  shape: readonly number[],
  data: CalculationInputLeaf['data'],
  tensorOrder = 0,
  axes?: readonly CalculationInputAxis[],
): CalculationInput {
  const externalShape = shape.slice(0, shape.length - tensorOrder)
  return {
    signal: {
      dtype: 'float64',
      shape,
      data,
      axes:
        axes ??
        externalShape.map((length, axis) => ({
          name: `axis ${axis}`,
          ticks: Array.from({ length }, (_item, tick) => tick),
        })),
      tensorOrder,
    },
  }
}

function loadCalculation(compiled: CompiledCalculationSource) {
  const calculationModule = { exports: {} as Record<string, unknown> }
  new Function('module', 'exports', 'require', CALCULATION_INDEX_GUARD_GLOBAL, compiled.code)(
    calculationModule,
    calculationModule.exports,
    () => ({}),
    calculationIndex,
  )
  return calculationModule.exports.default as (input: unknown) => unknown
}

async function main() {
  assert.match(CALCULATION_SOURCE_SKELETON, /export default function calculate\(record\)/u)
  assert.doesNotMatch(
    CALCULATION_SOURCE_SKELETON,
    /@(?:param|returns|type)\b|outputAxis|hasNumericTicks|ticks\.every|axis\.ticks\.map\(Number\)/u,
  )

  const source = sourceWithValue(0)
  const [first, duplicate] = await Promise.all([compileCalculationSource(source), compileCalculationSource(source)])
  assert.strictEqual(first, duplicate)
  assert.equal(calculationMonacoStubState.compileCount, 1)
  const firstUri = calculationMonacoStubState.modelUris[0]
  assert.equal(calculationMonacoStubState.modelLanguages[0], 'javascript')
  assert.equal(firstUri?.endsWith('/calculation.js'), true)
  const calculationModule = { exports: {} as Record<string, unknown> }
  new Function('module', 'exports', 'require', first.code)(calculationModule, calculationModule.exports, () => ({
    number: Number,
  }))
  assert.deepEqual((calculationModule.exports.default as (input: unknown) => unknown)({}), {
    dtype: 'float64',
    data: 0,
  })

  const computedIndexSource = `export default function calculate(input) {
  void input
  const matrix = [[1, 2], [3, 4]]
  const typed = new Float64Array([10, 20])
  const output = [0, 0, 0, 0]
  for (let row = 0; row < 2; row += 1) {
    for (let column = 0; column < 2; column += 1) {
      const cellIndex = row * 2 + column
      output[cellIndex] = matrix?.[row]?.[column] + typed[column]
    }
  }
  const first = 0
  output[first]++
  return { dtype: 'float64', data: output }
}`
  const computedIndexCalculation = loadCalculation(await compileCalculationSource(computedIndexSource))
  assert.deepEqual(computedIndexCalculation({}), { dtype: 'float64', data: [12, 22, 13, 24] })

  const guardedIndexSource = `export default function calculate(input) {
  const values = [10]
  const index = input.index
  return { dtype: 'float64', data: values[index] }
}`
  const guardedIndexCalculation = loadCalculation(await compileCalculationSource(guardedIndexSource))
  assert.deepEqual(guardedIndexCalculation({ index: 0 }), { dtype: 'float64', data: 10 })
  for (const index of ['0', 'constructor', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 0n] as const) {
    assert.throws(
      () => guardedIndexCalculation({ index }),
      (error: unknown) =>
        error instanceof CalculationExecutionError &&
        error.code === 'policy' &&
        error.diagnostic?.sourceLine === "  return { dtype: 'float64', data: values[index] }" &&
        error.diagnostic.range.startColumn === 43,
    )
  }

  const compiledSkeleton = await compileCalculationSource(CALCULATION_SOURCE_SKELETON)
  const skeletonModule = { exports: {} as Record<string, unknown> }
  new Function('module', 'exports', 'require', 'console', compiledSkeleton.code)(
    skeletonModule,
    skeletonModule.exports,
    (specifier: string) => {
      assert.equal(specifier, 'mathjs')
      return CALCULATION_MATHJS_RUNTIME
    },
    { log() {} },
  )
  const calculate = skeletonModule.exports.default as (input: CalculationInput) => unknown
  const runSkeleton = (input: CalculationInput) => {
    assertCalculationInput(input)
    return normalizeCalculationOutput(calculate(input))
  }
  assert.deepEqual(runSkeleton({}), {
    dtype: 'float64',
    shape: [1, 1],
    data: [0],
    axes: [
      { name: 'row', ticks: [0] },
      { name: 'column', ticks: [0] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([], 5)), {
    dtype: 'float64',
    shape: [1, 1],
    data: [5],
    axes: [
      { name: 'row', ticks: [0] },
      { name: 'column', ticks: [0] },
    ],
  })
  assert.deepEqual(
    runSkeleton(calculationInput([3], [1, 2, 3], 0, [{ name: 'time', ticks: [0.1, 0.2, 0.3], unit: 's' }])),
    {
      dtype: 'float64',
      shape: [1, 3],
      data: [1, 2, 3],
      axes: [
        { name: 'row', ticks: [0] },
        { name: 'time', ticks: [0.1, 0.2, 0.3], unit: 's' },
      ],
    },
  )
  assert.deepEqual(runSkeleton(calculationInput([2, 2], [1, 2, 3, 4])), {
    dtype: 'float64',
    shape: [2, 2],
    data: [1, 2, 3, 4],
    axes: [
      { name: 'axis 0', ticks: [0, 1] },
      { name: 'axis 1', ticks: [0, 1] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([2, 2, 2], [1, 2, 3, 4, 5, 6, 7, 8])), {
    dtype: 'float64',
    shape: [2, 2],
    data: [1.5, 3.5, 5.5, 7.5],
    axes: [
      { name: 'axis 0', ticks: [0, 1] },
      { name: 'axis 1', ticks: [0, 1] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([2, 2, 3], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 1)), {
    dtype: 'float64',
    shape: [2, 2],
    data: [1, 4, 7, 10],
    axes: [
      { name: 'axis 0', ticks: [0, 1] },
      { name: 'axis 1', ticks: [0, 1] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([3], [1, 2, 3], 1)), {
    dtype: 'float64',
    shape: [1, 1],
    data: [2],
    axes: [
      { name: 'row', ticks: [0] },
      { name: 'column', ticks: [0] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([0, 3], [])), {
    dtype: 'float64',
    shape: [0, 3],
    data: [],
    axes: [
      { name: 'axis 0', ticks: [] },
      { name: 'axis 1', ticks: [0, 1, 2] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([2, 0], [])), {
    dtype: 'float64',
    shape: [2, 0],
    data: [],
    axes: [
      { name: 'axis 0', ticks: [0, 1] },
      { name: 'axis 1', ticks: [] },
    ],
  })
  assert.deepEqual(runSkeleton(calculationInput([2, 3, 0], [])), {
    dtype: 'float64',
    shape: [2, 3],
    data: [0, 0, 0, 0, 0, 0],
    axes: [
      { name: 'axis 0', ticks: [0, 1] },
      { name: 'axis 1', ticks: [0, 1, 2] },
    ],
  })
  assert.deepEqual(
    runSkeleton(calculationInput([2], ['invalid', Number.POSITIVE_INFINITY], 0, [{ name: 'sample', ticks: [0, 1] }])),
    {
      dtype: 'float64',
      shape: [1, 2],
      data: [0, 0],
      axes: [
        { name: 'row', ticks: [0] },
        { name: 'sample', ticks: [0, 1] },
      ],
    },
  )
  assert.throws(
    () => runSkeleton(calculationInput([2], [1, 2], 0, [{ name: 'label', ticks: ['a', 'b'] }])),
    /Calculation output axes\[1\]\.ticks must contain 2 finite numbers/u,
  )

  for (let value = 1; value <= 33; value += 1) await compileCalculationSource(sourceWithValue(value))
  const compileCountBeforeRetry = calculationMonacoStubState.compileCount
  await compileCalculationSource(source)
  assert.equal(calculationMonacoStubState.compileCount, compileCountBeforeRetry + 1)
  assert.notEqual(calculationMonacoStubState.modelUris.at(-1), firstUri)
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
