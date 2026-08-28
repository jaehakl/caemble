import assert from 'node:assert/strict'
import { CALCULATION_SOURCE_SKELETON } from '../src/lib/calculation/declarations'
import { CALCULATION_MATHJS_NAMES } from '../src/lib/calculation/mathjsManifest'
import { CALCULATION_MATHJS_RUNTIME } from '../src/lib/calculation/mathRuntime'
import { CALCULATION_SHADOWED_GLOBAL_NAMES } from '../src/lib/calculation/runtimeGlobals'
import { createCalculationInput } from '../src/lib/calculation/input'
import { analyzeCalculationSource } from '../src/lib/calculation/sourcePolicy'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CalculationExecutionError,
  calculationInputDtypes,
} from '../src/lib/calculation/types'
import { assertCalculationInput, normalizeCalculationOutput } from '../src/lib/calculation/validation'
import type { RecordedData, RecordedDataRule } from '../src/lib/cad/model/descriptor'

assert.deepEqual(Object.keys(CALCULATION_MATHJS_RUNTIME).sort(), [...CALCULATION_MATHJS_NAMES].sort())
assert.equal((CALCULATION_MATHJS_RUNTIME.add as (left: number, right: number) => number)(2, 3), 5)
assert.equal('random' in CALCULATION_MATHJS_RUNTIME, false)
assert.equal('evaluate' in CALCULATION_MATHJS_RUNTIME, false)
assert.deepEqual(Object.keys(CALCULATION_MATHJS_RUNTIME.mean as object), [])
assert.equal('signatures' in (CALCULATION_MATHJS_RUNTIME.mean as object), false)
assert.equal('_typedFunctionData' in (CALCULATION_MATHJS_RUNTIME.mean as object), false)
assert.equal('fromJSON' in (CALCULATION_MATHJS_RUNTIME.number as object), false)
assert.deepEqual(calculationInputDtypes, [
  'bool',
  'string',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float16',
  'float32',
  'float64',
])
for (const name of [
  'Atomics',
  'Blob',
  'console',
  'CustomEvent',
  'Event',
  'File',
  'FinalizationRegistry',
  'Intl',
  'OffscreenCanvas',
  'SharedArrayBuffer',
  'Temporal',
  'URL',
  'WeakRef',
] as const) {
  assert.equal(CALCULATION_SHADOWED_GLOBAL_NAMES.includes(name), true)
}
const complex = (CALCULATION_MATHJS_RUNTIME.complex as (real: number, imaginary: number) => unknown)(1, 2)
const complexSquared = (
  CALCULATION_MATHJS_RUNTIME.multiply as (left: unknown, right: unknown) => { re: number; im: number }
)(complex, complex)
assert.deepEqual({ re: complexSquared.re, im: complexSquared.im }, { re: -3, im: 4 })
const complexMagnitude = (CALCULATION_MATHJS_RUNTIME.abs as (value: unknown) => number)(
  (CALCULATION_MATHJS_RUNTIME.complex as (real: number, imaginary: number) => unknown)(3, 4),
)
assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', shape: [], data: complexMagnitude, axes: [] }), {
  dtype: 'float64',
  shape: [],
  data: 5,
  axes: [],
})
const ode = (
  CALCULATION_MATHJS_RUNTIME.solveODE as (
    derivative: (_time: number, value: number) => number,
    interval: readonly [number, number],
    initial: number,
  ) => { t: readonly number[]; y: readonly number[] }
)((_time, value) => value, [0, 0.1], 1)
assert.equal(ode.t[0], 0)
assert.equal(ode.y[0], 1)

assert.doesNotThrow(() => analyzeCalculationSource(CALCULATION_SOURCE_SKELETON))
assert.throws(() =>
  analyzeCalculationSource(
    "import random from 'mathjs'; export default function run(input: CalculationInput) { return input }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { mean } from 'other'; export default function run(input: CalculationInput) { return input }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource('const state = 1; export default function run(input: CalculationInput) { return input }'),
)
assert.throws(() =>
  analyzeCalculationSource('export default async function run(input: CalculationInput) { return input }'),
)
assert.throws(() =>
  analyzeCalculationSource("export default function run(input: CalculationInput) { return Math['random']() }"),
)
assert.throws(() =>
  analyzeCalculationSource("export default function run(input: CalculationInput) { return fetch('/') }"),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input: CalculationInput) { const key = ['con', 'structor'].join(''); return (() => {})[key] }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { evaluate } from 'mathjs'; export default function run(input: CalculationInput) { return input }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input: CalculationInput) { return Reflect.get(() => {}, 'constructor') }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    'export default function run(input: CalculationInput) { const { constructor } = () => {}; return constructor }',
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input: CalculationInput) { const key = 'constructor'; const { [key]: Constructor } = (() => {}); return Constructor }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { mean } from 'mathjs'; export default function run(input: CalculationInput) { return (mean as any)._typedFunctionData }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { number } from 'mathjs'; export default function run(input: CalculationInput) { const { fromJSON } = number as any; return fromJSON }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input: CalculationInput) { return new Intl.DateTimeFormat('en-US', { second: 'numeric' }).format() }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    'export default function run(input: CalculationInput) { return Temporal.Now.instant().epochMilliseconds }',
  ),
)
for (const source of [
  "export default function run(input: CalculationInput) { return new Event('tick').timeStamp }",
  "export default function run(input: CalculationInput) { return new File([], 'input').lastModified }",
  'export default function run(input: CalculationInput) { return URL.createObjectURL(new Blob()).length }',
  'export default function run(input: CalculationInput) { return Number(new WeakRef(input).deref() !== undefined) }',
  'export default function run(input: CalculationInput) { return Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 0) }',
  'export default function run(input: CalculationInput) { return Number(crossOriginIsolated) }',
  'export default function run(input: CalculationInput) { return Number((1000).toLocaleString().length) }',
  'export default function run(input: CalculationInput) { return Number(Object.keys(console).length) }',
] as const) {
  assert.throws(() => analyzeCalculationSource(source))
}

const input = {
  signal: {
    dtype: 'float64',
    shape: [2],
    data: [1, 2],
    axes: [{ name: 'time', ticks: ['start', 'end'] }],
    quantityKind: 'Time',
    tensorOrder: 0,
    unit: 'm',
  },
}
assert.doesNotThrow(() => assertCalculationInput(input))
const rule = {
  target: [],
  label: 'signal',
  methodId: 'test',
  parameters: {},
  result: { dtype: 'float64', tensorOrder: 0, axes: [{ name: 'sample', ticks: ['a', 'b'] }] },
} as unknown as RecordedDataRule
const recorded = {
  signal: {
    shape: [2],
    axes: [{ ticks: ['a', 'b'] }],
    storage: { kind: 'inline', value: [10, 20] },
  },
} as RecordedData
assert.deepEqual(createCalculationInput([rule], recorded).signal.data, [10, 20])
const secondRule = { ...rule, label: 'signal2' } as RecordedDataRule
assert.throws(
  () =>
    createCalculationInput([rule, secondRule], {
      signal: {
        shape: [2],
        axes: [{ ticks: ['a', 'b'] }],
        storage: { kind: 'base64', data: '%', byteLength: CALCULATION_INPUT_MAX_BYTES / 2 },
      },
      signal2: {
        shape: [2],
        axes: [{ ticks: ['a', 'b'] }],
        storage: { kind: 'base64', data: '%', byteLength: CALCULATION_INPUT_MAX_BYTES / 2 },
      },
    } as RecordedData),
  (error: unknown) =>
    error instanceof Error && !(error instanceof CalculationExecutionError && error.code === 'input-too-large'),
)
assert.throws(
  () =>
    createCalculationInput([rule, secondRule], {
      signal: {
        shape: [2],
        axes: [{ ticks: ['a', 'b'] }],
        storage: { kind: 'base64', data: '%', byteLength: CALCULATION_INPUT_MAX_BYTES / 2 + 1 },
      },
      signal2: {
        shape: [2],
        axes: [{ ticks: ['a', 'b'] }],
        storage: { kind: 'base64', data: '%', byteLength: CALCULATION_INPUT_MAX_BYTES / 2 + 1 },
      },
    } as RecordedData),
  (error: unknown) => error instanceof CalculationExecutionError && error.code === 'input-too-large',
)
assert.throws(() =>
  createCalculationInput([rule], { signal: { ...recorded.signal, axes: [{ ticks: ['a', 'c'] }] } } as RecordedData),
)
assert.throws(() =>
  createCalculationInput(
    [{ ...rule, result: { ...rule.result, axes: [{ name: 'sample', ticks: [10, 20] }] } } as RecordedDataRule],
    { signal: { ...recorded.signal, axes: [{ implicitOrdinal: true }] } } as RecordedData,
  ),
)
assert.throws(
  () =>
    createCalculationInput([rule], {
      signal: {
        shape: [2],
        axes: [{ ticks: ['a', 'b'] }],
        storage: { kind: 'base64', data: 'invalid base64', byteLength: CALCULATION_INPUT_MAX_BYTES + 1 },
      },
    } as RecordedData),
  (error: unknown) => error instanceof CalculationExecutionError && error.code === 'input-too-large',
)
assert.throws(() =>
  createCalculationInput(
    [
      {
        ...rule,
        result: { dtype: 'float64', tensorOrder: 1, axes: [{ name: 'sample', ticks: [0, 1] }] },
      } as RecordedDataRule,
    ],
    {
      signal: {
        shape: [2, 2],
        axes: [{ ticks: [0, 1] }],
        storage: {
          kind: 'inline',
          value: [
            [1, 2],
            [3, 4],
          ],
        },
      },
    } as RecordedData,
  ),
)

assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', shape: [], data: 2, axes: [] }), {
  dtype: 'float64',
  shape: [],
  data: 2,
  axes: [],
})
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'float32',
    shape: [2],
    data: [1, 2],
    axes: [{ name: 'x', ticks: [0, 1], unit: 'm' }],
  }),
  { dtype: 'float32', shape: [2], data: [1, 2], axes: [{ name: 'x', ticks: [0, 1], unit: 'm' }] },
)
assert.throws(
  () =>
    normalizeCalculationOutput({
      dtype: 'float64',
      shape: [1, CALCULATION_OUTPUT_MAX_ELEMENTS],
      data: [],
      axes: [],
    }),
  (error: unknown) =>
    error instanceof Error &&
    !(error instanceof CalculationExecutionError && error.code === 'output-too-large') &&
    error.message.includes('does not match shape'),
)
assert.throws(
  () =>
    normalizeCalculationOutput({
      dtype: 'float64',
      shape: [1, CALCULATION_OUTPUT_MAX_ELEMENTS + 1],
      data: [],
      axes: [],
    }),
  (error: unknown) => error instanceof CalculationExecutionError && error.code === 'output-too-large',
)
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'int16',
    shape: [2, 2],
    data: [1, 2, 3, 4],
    axes: [
      { name: 'y', ticks: [0, 1] },
      { name: 'x', ticks: [0, 1] },
    ],
  }).data,
  [1, 2, 3, 4],
)
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'float64',
    shape: [2, 2],
    data: {
      isMatrix: true,
      size: () => [2, 2],
      toArray: () => [
        [1, 2],
        [3, 4],
      ],
    },
    axes: [
      { name: 'y', ticks: [0, 1] },
      { name: 'x', ticks: [0, 1] },
    ],
  }).data,
  [1, 2, 3, 4],
)
assert.throws(() =>
  normalizeCalculationOutput({
    dtype: 'float64',
    shape: [2, 2],
    data: [
      [1, 2],
      [3, 4],
    ],
    axes: [
      { name: 'y', ticks: [0, 1] },
      { name: 'x', ticks: [0, 1] },
    ],
  }),
)
assert.throws(() =>
  normalizeCalculationOutput({
    dtype: 'float64',
    shape: [2, 2],
    data: { isMatrix: true, size: () => [4], toArray: () => [1, 2, 3, 4] },
    axes: [
      { name: 'y', ticks: [0, 1] },
      { name: 'x', ticks: [0, 1] },
    ],
  }),
)
assert.throws(() =>
  normalizeCalculationOutput({ dtype: 'float64', shape: [], data: { isComplex: true, re: 1, im: 2 }, axes: [] }),
)
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', shape: [], data: complex, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', shape: [], data: Number.NaN, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'uint8', shape: [], data: 256, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float32', shape: [], data: Number.MAX_VALUE, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', shape: [], data: 1, axes: [], unit: 'm' }))
