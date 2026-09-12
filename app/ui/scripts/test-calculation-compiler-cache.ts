import assert from 'node:assert/strict'
import { calculationExampleInput } from '../src/authoring/examples'
import { BOX_GRID_AXES } from '../src/contracts/boxGrid'
import { calculationMonacoStubState } from './calculation-monaco-stub'
import { compileCalculationSource } from '../src/lib/calculation/compiler'
import { CALCULATION_SOURCE_SKELETON } from '../src/lib/calculation/declarations'
import { calculationIndex } from '../src/lib/calculation/indexGuard'
import { CALCULATION_MATHJS_RUNTIME } from '../src/lib/calculation/mathRuntime'
import { CALCULATION_INDEX_GUARD_GLOBAL } from '../src/lib/calculation/runtimeGlobals'
import {
  CalculationExecutionError,
  type CalculationInput,
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

function calculationInput(shape: readonly number[], data: readonly number[]): CalculationInput {
  const channels = shape[5] === 2 ? (['amplitude', 'phase'] as const) : (['value'] as const)
  const gridShape = shape.slice(0, 3) as [number, number, number]
  return {
    signal: {
      ...calculationExampleInput.signal,
      shape,
      data,
      boxGrid: {
        ...calculationExampleInput.signal.boxGrid,
        gridShape,
        size: gridShape,
        channels,
        channelUnits: channels.length === 2 ? ['1', 'rad'] : ['1'],
      },
      axes: BOX_GRID_AXES.map((name, axis) => ({
        name,
        ticks:
          axis === 5
            ? channels
            : axis === 6
              ? ['scalar']
              : Array.from({ length: shape[axis] }, (_, index) => (axis < 3 ? index + 0.5 : index)),
      })),
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
  new Function('module', 'exports', 'require', 'console', CALCULATION_INDEX_GUARD_GLOBAL, compiledSkeleton.code)(
    skeletonModule,
    skeletonModule.exports,
    (specifier: string) => {
      assert.equal(specifier, 'mathjs')
      return CALCULATION_MATHJS_RUNTIME
    },
    { log() {} },
    calculationIndex,
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
  assert.deepEqual(runSkeleton(calculationInput([2, 2, 1, 1, 1, 1, 1], [1, 2, 3, 4])), {
    dtype: 'float64',
    shape: [2, 2],
    data: [1, 2, 3, 4],
    axes: [
      { name: 'x', ticks: [0.5, 1.5] },
      { name: 'y', ticks: [0.5, 1.5] },
    ],
  })
  // A/phase must never be averaged together by the default source.
  assert.deepEqual(
    runSkeleton(
      calculationInput(
        [2, 2, 2, 1, 1, 2, 1],
        Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? index : index === 1 ? 0 : 0.5)),
      ),
    ),
    {
      dtype: 'float64',
      shape: [2, 2],
      data: [0, 4, 8, 12],
      axes: [
        { name: 'x', ticks: [0.5, 1.5] },
        { name: 'y', ticks: [0.5, 1.5] },
      ],
    },
  )
  assert.throws(() => runSkeleton(calculationInput([0, 2, 1, 1, 1, 1, 1], [])))
  assert.throws(() => runSkeleton(calculationInput([1, 1, 1, 1, 1, 1, 1], [Number.POSITIVE_INFINITY])))

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
