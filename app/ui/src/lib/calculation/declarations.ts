import { CALCULATION_MATHJS_NAMES } from './mathjsManifest'
import { calculationInputDtypes } from './types'

const mathJsSpecialDeclarations: Readonly<Record<string, string>> = Object.freeze({
  complex: 'export function complex(re?: number, im?: number): MathJsComplex',
  e: 'export const e: number',
  i: 'export const i: MathJsComplex',
  index: 'export function index(...ranges: any[]): any',
  map: 'export function map<T>(data: T, callback: (value: any, index: readonly number[], data: T) => any): any',
  matrix: 'export function matrix<T = unknown>(data?: T): MathJsMatrix<T>',
  mean: 'export function mean(data: any, dimension?: number): any',
  number: 'export function number(value?: any): number',
  pi: 'export const pi: number',
  range:
    'export function range(start: number, end: number, step?: number, includeEnd?: boolean): MathJsMatrix<readonly number[]>',
  reshape: 'export function reshape(data: any, sizes: readonly number[]): any',
  size: 'export function size(data: any): readonly number[]',
  squeeze: 'export function squeeze(data: any): any',
  subset: 'export function subset(data: any, index: any, replacement?: any, defaultValue?: any): any',
  tau: 'export const tau: number',
  transpose: 'export function transpose(data: any): any',
  zeros: 'export function zeros(rows: number, columns: number): MathJsMatrix<readonly (readonly number[])[]>',
})

const mathJsMembers = CALCULATION_MATHJS_NAMES.map(
  (name) => mathJsSpecialDeclarations[name] ?? `export function ${name}(...args: any[]): any`,
).join('\n  ')

export const CALCULATION_MONACO_DECLARATION = `
interface MathJsComplex {
  readonly isComplex: true
  readonly re: number
  readonly im: number
}

interface MathJsMatrix<T = unknown> {
  readonly isMatrix: true
  size(): readonly number[]
  toArray(): T
  valueOf(): T
}

type CalculationDtype =
  | 'float32' | 'float64'
  | 'int8' | 'int16' | 'int32'
  | 'uint8' | 'uint16' | 'uint32'

interface CalculationAxis {
  readonly name: string
  readonly ticks: readonly number[]
  readonly unit?: string
}

interface CalculationInputAxis {
  readonly name: string
  readonly ticks: readonly (number | string)[]
  readonly unit?: string
}

interface CalculationInputLeaf {
  readonly dtype: ${calculationInputDtypes.map((dtype) => `'${dtype}'`).join(' | ')}
  readonly shape: readonly number[]
  readonly data: readonly number[]
  readonly axes: readonly CalculationInputAxis[]
  readonly quantityKind?: string
  readonly tensorOrder: number
  readonly unit?: string
  readonly boxGrid: {
    readonly version: 1
    readonly sampling: 'point' | 'cell-average' | 'aggregate'
    readonly components: readonly string[]
    readonly channels: readonly ['value'] | readonly ['amplitude', 'phase']
    readonly channelUnits: readonly string[]
    readonly frequencyKind?: 'modal' | 'sampled'
    readonly origin: readonly [number, number, number]
    readonly size: readonly [number, number, number]
    readonly rotation: readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]]
    readonly lengthUnit: string
    readonly gridShape: readonly [number, number, number]
    readonly source: 'experiment' | 'task'
    readonly rootId: string
  }
}

type CalculationInput = Readonly<Record<string, CalculationInputLeaf>>

interface CalculationOutput {
  readonly dtype: CalculationDtype
  readonly data: number | readonly number[] | readonly (readonly number[])[] | MathJsMatrix
  readonly axes?: readonly CalculationAxis[]
}

declare module 'mathjs' {
  ${mathJsMembers}
}
`

export const CALCULATION_MATHJS_DECLARATION = CALCULATION_MONACO_DECLARATION

export const CALCULATION_SOURCE_SKELETON = `import { range } from 'mathjs'

export default function calculate(record) {
  const source = record['signal']

  // Axes: x, y, z, time, frequency, amplitudePhase, component.
  // Display the XY plane at the first z/time/frequency/channel/component.
  const shape = source?.shape ?? [1, 1, 1, 1, 1, 1, 1]
  const rows = shape[0]
  const columns = shape[1]
  const stride = shape.slice(2).reduce((size, length) => size * length, 1)
  const rawData = source && Array.isArray(source.data) ? source.data : [0]
  const data = Array.from({ length: rows }, (_, x) =>
    Array.from({ length: columns }, (_, y) => Number(rawData[(x * columns + y) * stride] ?? 0)))
  const rowAxis = source?.axes[0]
  const columnAxis = source?.axes[1]
  const axes = [
    rowAxis ?? { name: 'row', ticks: range(0, rows).toArray() },
    columnAxis ?? { name: 'column', ticks: range(0, columns).toArray() },
  ]

  console.log('Returning 2D summary', { dtype: 'float64', rows, columns })
  return { dtype: 'float64', data, axes }
}
`

export function calculationSourceSkeleton(recordName?: string) {
  if (!recordName) return CALCULATION_SOURCE_SKELETON
  return CALCULATION_SOURCE_SKELETON.replace(
    "record['signal']",
    `record[${JSON.stringify(recordName)}]`,
  )
}
