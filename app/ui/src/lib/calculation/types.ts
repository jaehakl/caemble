import type { DataDType } from '@/lib/cad'

export const CALCULATION_INPUT_MAX_BYTES = 64 * 1024 * 1024
export const CALCULATION_OUTPUT_MAX_ELEMENTS = 5_000_000
export const CALCULATION_TIMEOUT_MS = 30_000
export const CALCULATION_LOG_MAX_ENTRIES = 100
export const CALCULATION_LOG_MAX_ENTRY_BYTES = 4 * 1024
export const CALCULATION_LOG_MAX_BYTES = 64 * 1024

export const calculationInputDtypes = [
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
] as const satisfies readonly DataDType[]

export const calculationDtypes = ['float32', 'float64', 'int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32'] as const

export type CalculationDtype = (typeof calculationDtypes)[number]
export type CalculationInputDtype = (typeof calculationInputDtypes)[number]

export type CalculationAxis = Readonly<{
  name: string
  ticks: readonly number[]
  unit?: string
}>

export type CalculationInputAxis = Readonly<{
  name: string
  ticks: readonly (number | string)[]
  unit?: string
}>

export type CalculationInputLeaf = Readonly<{
  dtype: CalculationInputDtype
  shape: readonly number[]
  data: boolean | string | number | readonly (boolean | string | number)[]
  axes: readonly CalculationInputAxis[]
  quantityKind?: string
  tensorOrder: number
  unit?: string
}>

export type CalculationInput = Readonly<Record<string, CalculationInputLeaf>>

export type MathJsMatrix = Readonly<{
  isMatrix: true
  size: () => readonly number[]
  toArray: () => unknown
  valueOf: () => unknown
}>

export type CalculationOutput = Readonly<{
  dtype: CalculationDtype
  data: number | readonly number[] | readonly (readonly number[])[] | MathJsMatrix
  axes?: readonly CalculationAxis[]
}>

export type NormalizedCalculationOutput = Readonly<{
  dtype: CalculationDtype
  shape: readonly [] | readonly [number] | readonly [number, number]
  data: number | readonly number[]
  axes: readonly CalculationAxis[]
}>

export type CalculationLogEntry = Readonly<{
  requestId: string
  revision: number
  sourceHash: string
  sequence: number
  message: string
}>

export const calculationExecutionErrorCodes = [
  'policy',
  'compile',
  'input-too-large',
  'runtime',
  'timeout',
  'output-too-large',
  'cancelled',
] as const

export type CalculationExecutionErrorCode = (typeof calculationExecutionErrorCodes)[number]

export type CalculationSourceDiagnostic = Readonly<{
  message: string
  range: Readonly<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  sourceLine: string
}>

export class CalculationExecutionError extends Error {
  readonly code: CalculationExecutionErrorCode
  readonly diagnostic: CalculationSourceDiagnostic | undefined

  constructor(code: CalculationExecutionErrorCode, message: string, diagnostic?: CalculationSourceDiagnostic) {
    super(message)
    this.name = 'CalculationExecutionError'
    this.code = code
    this.diagnostic = diagnostic
  }
}

export type CompiledCalculationSource = Readonly<{
  code: string
  sourceHash: string
}>
