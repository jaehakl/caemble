import type { CalculationInput, NormalizedCalculationOutput } from '../lib/calculation/types'

/** Synthetic data, deliberately independent of Catalog records and server measurements. */
export const calculationExampleInput: CalculationInput = {
  signal: {
    dtype: 'float64',
    shape: [1, 1, 1, 4, 1, 1, 1],
    data: [2, 4, 6, 8],
    axes: [
      ...['x', 'y', 'z'].map((name) => ({ name, ticks: [0.5], unit: 'm' })),
      { name: 'time', ticks: [0, 1, 2, 3], unit: 's' },
      { name: 'frequency', ticks: [0], unit: 'Hz' },
      { name: 'amplitudePhase', ticks: ['value'] },
      { name: 'component', ticks: ['scalar'] },
    ],
    tensorOrder: 0,
    boxGrid: {
      version: 1,
      sampling: 'point',
      components: ['scalar'],
      channels: ['value'],
      channelUnits: ['1'],
      origin: [0, 0, 0],
      size: [1, 1, 1],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      lengthUnit: 'm',
      gridShape: [1, 1, 1],
      source: 'task',
      rootId: 'sample',
    },
  },
}

export const calculationExamples: readonly Readonly<{
  id: string
  title: string
  source: string
  input: CalculationInput
  expected: NormalizedCalculationOutput
}>[] = [
  {
    id: 'calculation.example.mean',
    title: 'Complete Calculation: scalar mean of one fixed record',
    source: `import { mean } from 'mathjs'

/** @param {CalculationInput} record */
export default function calculate(record) {
  const signal = record['signal']
  const samples = Array.isArray(signal.data) ? signal.data.map(Number) : [Number(signal.data)]
  console.log('sample count', samples.length)
  return { dtype: 'float64', data: Number(mean(samples)) }
}
`,
    input: calculationExampleInput,
    expected: { dtype: 'float64', shape: [], data: 5, axes: [] },
  },
  {
    id: 'calculation.example.line',
    title: 'Complete Calculation: numeric line with an explicit axis',
    source: `/** @param {CalculationInput} record */
export default function calculate(record) {
  const signal = record.signal
  const samples = Array.isArray(signal.data) ? signal.data.map(Number) : [Number(signal.data)]
  return {
    dtype: 'float64',
    data: samples.map((value) => value * 2),
    axes: [{ name: 'sample', ticks: samples.map((_value, index) => index) }],
  }
}
`,
    input: calculationExampleInput,
    expected: {
      dtype: 'float64',
      shape: [4],
      data: [4, 8, 12, 16],
      axes: [{ name: 'sample', ticks: [0, 1, 2, 3] }],
    },
  },
  {
    id: 'calculation.example.heatmap',
    title: 'Complete Calculation: reshape to a two-dimensional result',
    source: `import { reshape } from 'mathjs'

/** @param {CalculationInput} record */
export default function calculate(record) {
  const signal = record['signal']
  const samples = Array.isArray(signal.data) ? signal.data.map(Number) : [Number(signal.data)]
  return {
    dtype: 'float64',
    data: reshape(samples, [2, 2]),
    axes: [{ name: 'row', ticks: [0, 1] }, { name: 'column', ticks: [0, 1] }],
  }
}
`,
    input: calculationExampleInput,
    expected: {
      dtype: 'float64',
      shape: [2, 2],
      data: [2, 4, 6, 8],
      axes: [
        { name: 'row', ticks: [0, 1] },
        { name: 'column', ticks: [0, 1] },
      ],
    },
  },
]

/** Invalid examples name the stage that rejects them; snippets are never advertised as full simulations. */
export const calculationInvalidExamples = [
  {
    id: 'async-export',
    stage: 'policy',
    source: 'export default async function calculate(record) { return { dtype: "float64", data: 1 } }',
  },
  {
    id: 'default-import',
    stage: 'policy',
    source:
      'import math from "mathjs"; export default function calculate(record) { return { dtype: "float64", data: 1 } }',
  },
  {
    id: 'random',
    stage: 'policy',
    source: 'export default function calculate(record) { return { dtype: "float64", data: Math.random() } }',
  },
  {
    id: 'dynamic-record',
    stage: 'dependencies',
    source:
      'export default function calculate(record) { const key = "signal"; return { dtype: "float64", data: record[key].data } }',
  },
  {
    id: 'type-error',
    stage: 'compile',
    source:
      'export default function calculate(record) { const value = "text"; return { dtype: "float64", data: value.toFixed(2) } }',
  },
  {
    id: 'ragged-output',
    stage: 'output',
    source: 'export default function calculate(record) { return { dtype: "float64", data: [[1], [2, 3]] } }',
  },
  {
    id: 'nonfinite-output',
    stage: 'output',
    source: 'export default function calculate(record) { return { dtype: "float64", data: Infinity } }',
  },
] as const

export const geometrySyntaxExamples = {
  valid: `import { Box, type Geometry, type Vec3 } from '@caemble/core'
export const Part: Geometry<{ size: Vec3 }> = ({ size = [1, 2, 3] }) => <Box id="body" size={size} />
`,
  invalid: `import { Box, type Geometry, type Vec3 } from '@caemble/core'
export const Part: Geometry<{ size: Vec3 }> = (props) => <Box size={props.size} />
`,
} as const
