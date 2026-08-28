import assert from 'node:assert/strict'
import { CALCULATION_SOURCE_SKELETON } from '../src/lib/calculation/declarations'
import { CALCULATION_MATHJS_NAMES } from '../src/lib/calculation/mathjsManifest'
import { CALCULATION_MATHJS_RUNTIME } from '../src/lib/calculation/mathRuntime'
import { CALCULATION_SHADOWED_GLOBAL_NAMES } from '../src/lib/calculation/runtimeGlobals'
import { createCalculationInput } from '../src/lib/calculation/input'
import { createCalculationConsole } from '../src/lib/calculation/log'
import { assertCalculationRunnerLogEnvelope } from '../src/lib/calculation/protocol'
import { analyzeCalculationSource } from '../src/lib/calculation/sourcePolicy'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CalculationExecutionError,
  calculationInputDtypes,
} from '../src/lib/calculation/types'
import {
  assertCalculationInput,
  normalizeCalculationOutput,
  normalizeCalculationRunnerOutput,
} from '../src/lib/calculation/validation'
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
assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', data: complexMagnitude }), {
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
assert.doesNotThrow(() => analyzeCalculationSource('export default function run(record) { return record }'))
assert.doesNotThrow(() => analyzeCalculationSource('export default function run(value) { return value }'))
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input: CalculationInput) { return { dtype: 'float64', data: input } }",
  ),
)
assert.throws(() => analyzeCalculationSource('export default function run(input) { return <div>{input}</div> }'))
assert.doesNotThrow(() =>
  analyzeCalculationSource(
    "export default function run(input) { console.log('input', input); return { dtype: 'float64', data: 1 } }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { console.error(input); return { dtype: 'float64', data: 1 } }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { console['log'](input); return { dtype: 'float64', data: 1 } }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { const log = console.log; log(input); return { dtype: 'float64', data: 1 } }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource("import random from 'mathjs'; export default function run(input) { return input }"),
)
assert.throws(() =>
  analyzeCalculationSource("import { mean } from 'other'; export default function run(input) { return input }"),
)
assert.throws(() => analyzeCalculationSource('const state = 1; export default function run(input) { return input }'))
assert.throws(() => analyzeCalculationSource('export default async function run(input) { return input }'))
assert.throws(() => analyzeCalculationSource("export default function run(input) { return Math['random']() }"))
assert.throws(() => analyzeCalculationSource("export default function run(input) { return fetch('/') }"))
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { const key = ['con', 'structor'].join(''); return (() => {})[key] }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource("import { evaluate } from 'mathjs'; export default function run(input) { return input }"),
)
assert.throws(() =>
  analyzeCalculationSource("export default function run(input) { return Reflect.get(() => {}, 'constructor') }"),
)
assert.throws(() =>
  analyzeCalculationSource(
    'export default function run(input) { const { constructor } = () => {}; return constructor }',
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { const key = 'constructor'; const { [key]: Constructor } = (() => {}); return Constructor }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { mean } from 'mathjs'; export default function run(input) { return mean._typedFunctionData }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "import { number } from 'mathjs'; export default function run(input) { const { fromJSON } = number; return fromJSON }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource(
    "export default function run(input) { return new Intl.DateTimeFormat('en-US', { second: 'numeric' }).format() }",
  ),
)
assert.throws(() =>
  analyzeCalculationSource('export default function run(input) { return Temporal.Now.instant().epochMilliseconds }'),
)
for (const source of [
  "export default function run(input) { return new Event('tick').timeStamp }",
  "export default function run(input) { return new File([], 'input').lastModified }",
  'export default function run(input) { return URL.createObjectURL(new Blob()).length }',
  'export default function run(input) { return Number(new WeakRef(input).deref() !== undefined) }',
  'export default function run(input) { return Atomics.load(new Int32Array(new SharedArrayBuffer(4)), 0) }',
  'export default function run(input) { return Number(crossOriginIsolated) }',
  'export default function run(input) { return Number((1000).toLocaleString().length) }',
  'export default function run(input) { return Number(Object.keys(console).length) }',
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

assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', data: 2 }), {
  dtype: 'float64',
  shape: [],
  data: 2,
  axes: [],
})
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'float32',
    data: [1, 2],
    axes: [{ name: 'x', ticks: [0, 1], unit: 'm' }],
  }),
  { dtype: 'float32', shape: [2], data: [1, 2], axes: [{ name: 'x', ticks: [0, 1], unit: 'm' }] },
)
assert.throws(
  () =>
    normalizeCalculationOutput({
      dtype: 'float64',
      data: {
        isMatrix: true,
        size: () => [1, CALCULATION_OUTPUT_MAX_ELEMENTS],
        toArray: () => [],
      },
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
      data: {
        isMatrix: true,
        size: () => [1, CALCULATION_OUTPUT_MAX_ELEMENTS + 1],
        toArray: () => {
          throw new Error('must not materialize oversized Matrix')
        },
      },
      axes: [],
    }),
  (error: unknown) => error instanceof CalculationExecutionError && error.code === 'output-too-large',
)
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'int16',
    data: [
      [1, 2],
      [3, 4],
    ],
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
    data: { isMatrix: true, size: () => [4], toArray: () => [1, 2, 3, 4] },
    axes: [
      { name: 'y', ticks: [0, 1] },
      { name: 'x', ticks: [0, 1] },
    ],
  }),
)
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: { isComplex: true, re: 1, im: 2 }, axes: [] }))
assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', data: [] }), {
  dtype: 'float64',
  shape: [0],
  data: [],
  axes: [{ name: 'index', ticks: [] }],
})
assert.deepEqual(normalizeCalculationOutput({ dtype: 'float64', data: [[], []] }), {
  dtype: 'float64',
  shape: [2, 0],
  data: [],
  axes: [
    { name: 'row', ticks: [0, 1] },
    { name: 'column', ticks: [] },
  ],
})
assert.deepEqual(
  normalizeCalculationOutput({
    dtype: 'float64',
    data: [
      [1, 2],
      [3, 4],
    ],
  }),
  {
    dtype: 'float64',
    shape: [2, 2],
    data: [1, 2, 3, 4],
    axes: [
      { name: 'row', ticks: [0, 1] },
      { name: 'column', ticks: [0, 1] },
    ],
  },
)
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', shape: [], data: 1 }))
assert.deepEqual(
  normalizeCalculationRunnerOutput({
    dtype: 'float64',
    shape: [2],
    data: [1, 2],
    axes: [{ name: 'x', ticks: [0, 1] }],
  }),
  { dtype: 'float64', shape: [2], data: [1, 2], axes: [{ name: 'x', ticks: [0, 1] }] },
)
assert.throws(() => normalizeCalculationRunnerOutput({ dtype: 'float64', shape: [2], data: [1, 2] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: [1, 2], axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: [[1], [2, 3]] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: [[[1]]] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: complex, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: Number.NaN, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'uint8', data: 256, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float32', data: Number.MAX_VALUE, axes: [] }))
assert.throws(() => normalizeCalculationOutput({ dtype: 'float64', data: 1, axes: [], unit: 'm' }))

const logMessages: string[] = []
const calculationConsole = createCalculationConsole((message) => logMessages.push(message))
const circular: { self?: unknown } = {}
circular.self = circular
calculationConsole.log('value', 3, [1, 2], circular)
assert.equal(logMessages[0], 'value 3 [1, 2] {self: [Circular]}')
calculationConsole.log('x'.repeat(10_000))
assert.equal(new TextEncoder().encode(logMessages[1]).byteLength <= 4 * 1024, true)
const cappedMessages: string[] = []
const cappedConsole = createCalculationConsole((message) => cappedMessages.push(message))
for (let index = 0; index < 102; index += 1) cappedConsole.log(index)
assert.equal(cappedMessages.length, 101)
assert.equal(cappedMessages.at(-1), '[Calculation console.log output truncated]')

assert.doesNotThrow(() =>
  assertCalculationRunnerLogEnvelope({
    type: 'operation-log',
    operation: 'calculate',
    nonce: '12345678-1234-1234-1234-123456789012',
    requestId: 'request',
    revision: 1,
    sourceHash: 'hash',
    sequence: 1,
    message: 'hello',
  }),
)
assert.throws(() =>
  assertCalculationRunnerLogEnvelope({
    type: 'operation-log',
    operation: 'calculate',
    nonce: '12345678-1234-1234-1234-123456789012',
    requestId: 'request',
    revision: 1,
    sourceHash: 'hash',
    sequence: 0,
    message: 'hello',
  }),
)
