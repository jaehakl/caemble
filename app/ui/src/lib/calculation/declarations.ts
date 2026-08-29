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
  readonly data: boolean | string | number | readonly (boolean | string | number)[]
  readonly axes: readonly CalculationInputAxis[]
  readonly quantityKind?: string
  readonly tensorOrder: number
  readonly unit?: string
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

export const CALCULATION_SOURCE_SKELETON = `import { mean, range, reshape, zeros } from 'mathjs'

export default function calculate(record) {
  const source = record['signal']

  // 1. Decide which two dimensions to display.
  const shape = source?.shape ?? []
  const tensorOrder = source?.tensorOrder ?? 0
  const spatialShape = shape.slice(0, shape.length - tensorOrder)
  const rows = spatialShape.length >= 2 ? (spatialShape[0] ?? 0) : 1
  const columns = spatialShape.length >= 2 ? (spatialShape[1] ?? 0) : (spatialShape[0] ?? 1)

  // 2. Restore the tensor and average every dimension after rows and columns.
  const rawData = source ? (Array.isArray(source.data) ? source.data : [source.data]) : [0]
  const numericData = rawData.map(Number).map((value) => (Number.isFinite(value) ? value : 0))
  let data = zeros(rows, columns)
  if (!shape.includes(0)) {
    let tensor = reshape(numericData, shape.length > 0 ? shape : [1])
    for (let axis = shape.length - 1; axis >= Math.min(spatialShape.length, 2); axis -= 1) {
      tensor = mean(tensor, axis)
    }
    data = reshape(Array.isArray(tensor) ? tensor : [tensor], [rows, columns])
  }

  // 3. Keep source axes and add ordinal axes only for new dimensions.
  const rowAxis = spatialShape.length >= 2 ? source?.axes[0] : undefined
  const columnAxis = spatialShape.length === 1
    ? source?.axes[0]
    : spatialShape.length >= 2
      ? source?.axes[1]
      : undefined
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
