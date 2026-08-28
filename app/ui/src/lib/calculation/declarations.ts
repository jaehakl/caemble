import { CALCULATION_MATHJS_NAMES } from './mathjsManifest'
import { calculationInputDtypes } from './types'

const mathJsSpecialDeclarations: Readonly<Record<string, string>> = Object.freeze({
  complex: 'export function complex(re?: number, im?: number): MathJsComplex',
  e: 'export const e: number',
  i: 'export const i: MathJsComplex',
  index: 'export function index(...ranges: any[]): any',
  matrix: 'export function matrix(data?: any): MathJsMatrix',
  number: 'export function number(value?: any): number',
  pi: 'export const pi: number',
  tau: 'export const tau: number',
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

interface MathJsMatrix {
  readonly isMatrix: true
  size(): readonly number[]
  toArray(): unknown
  valueOf(): unknown
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
  readonly shape: readonly [] | readonly [number] | readonly [number, number]
  readonly data: number | readonly number[] | MathJsMatrix
  readonly axes: readonly CalculationAxis[]
}

declare module 'mathjs' {
  ${mathJsMembers}
}
`

export const CALCULATION_MATHJS_DECLARATION = CALCULATION_MONACO_DECLARATION

export const CALCULATION_SOURCE_SKELETON = `import { mean } from 'mathjs'

export default function calculate(input: CalculationInput): CalculationOutput {
  const first = Object.values(input)[0]
  const values = first
    ? (Array.isArray(first.data) ? first.data : [first.data]).map(Number)
    : []
  return {
    dtype: 'float64',
    shape: [],
    data: values.length === 0 ? 0 : mean(values),
    axes: [],
  }
}
`
