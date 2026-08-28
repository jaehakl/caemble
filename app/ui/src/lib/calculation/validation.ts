import { convertUcumValue } from '@/lib/cad/model/units'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CalculationExecutionError,
  calculationDtypes,
  calculationInputDtypes,
  type CalculationInput,
  type NormalizedCalculationOutput,
} from './types'

const pathPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}(?:\.[A-Za-z_][A-Za-z0-9_]{0,62})*$/u
const integerRanges = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
} as const)
const inputDtypes = new Set<string>(calculationInputDtypes)

function secureRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  return value as Record<string, unknown>
}

function secureShape(value: unknown, path: string): readonly number[] {
  if (!Array.isArray(value) || value.some((length) => !Number.isSafeInteger(length) || length < 0)) {
    throw new Error(`${path} must contain non-negative safe integers.`)
  }
  return value as readonly number[]
}

function validateAxes(value: unknown, shape: readonly number[], path: string) {
  if (!Array.isArray(value) || value.length !== shape.length) {
    throw new Error(`${path} must contain exactly ${shape.length} axes.`)
  }
  return Object.freeze(
    value.map((rawAxis, index) => {
      const axis = secureRecord(rawAxis, `${path}[${index}]`)
      const unexpected = Object.keys(axis).filter((key) => !['name', 'ticks', 'unit'].includes(key))
      if (unexpected.length > 0)
        throw new Error(`${path}[${index}] contains unsupported fields: ${unexpected.join(', ')}.`)
      if (typeof axis.name !== 'string' || axis.name.trim() === '')
        throw new Error(`${path}[${index}].name is invalid.`)
      if (
        !Array.isArray(axis.ticks) ||
        axis.ticks.length !== shape[index] ||
        axis.ticks.some((tick) => typeof tick !== 'number' || !Number.isFinite(tick))
      ) {
        throw new Error(`${path}[${index}].ticks must contain ${shape[index]} finite numbers.`)
      }
      if (axis.unit !== undefined) {
        if (typeof axis.unit !== 'string' || axis.unit.trim() === '')
          throw new Error(`${path}[${index}].unit is invalid.`)
        convertUcumValue(1, axis.unit, axis.unit, `${path}[${index}].unit`)
      }
      return Object.freeze({
        name: axis.name,
        ticks: Object.freeze([...(axis.ticks as number[])]),
        ...(axis.unit === undefined ? {} : { unit: axis.unit }),
      })
    }),
  )
}

function validateInputAxes(value: unknown, shape: readonly number[], path: string) {
  if (!Array.isArray(value) || value.length !== shape.length) {
    throw new Error(`${path} must contain exactly ${shape.length} axes.`)
  }
  value.forEach((rawAxis, index) => {
    const axis = secureRecord(rawAxis, `${path}[${index}]`)
    const unexpected = Object.keys(axis).filter((key) => !['name', 'ticks', 'unit'].includes(key))
    if (unexpected.length > 0)
      throw new Error(`${path}[${index}] contains unsupported fields: ${unexpected.join(', ')}.`)
    if (typeof axis.name !== 'string' || axis.name.trim() === '') throw new Error(`${path}[${index}].name is invalid.`)
    if (
      !Array.isArray(axis.ticks) ||
      axis.ticks.length !== shape[index] ||
      axis.ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))
    ) {
      throw new Error(`${path}[${index}].ticks must contain ${shape[index]} finite numbers or strings.`)
    }
    if (axis.unit !== undefined) {
      if (typeof axis.unit !== 'string' || axis.unit.trim() === '')
        throw new Error(`${path}[${index}].unit is invalid.`)
      convertUcumValue(1, axis.unit, axis.unit, `${path}[${index}].unit`)
    }
  })
}

export function assertCalculationInput(value: unknown): asserts value is CalculationInput {
  const input = secureRecord(value, 'Calculation input')
  Object.entries(input).forEach(([path, rawLeaf]) => {
    if (!pathPattern.test(path)) throw new Error(`Calculation input path is invalid: ${path}`)
    const leaf = secureRecord(rawLeaf, `Calculation input ${path}`)
    const unexpected = Object.keys(leaf).filter(
      (key) => !['dtype', 'shape', 'data', 'axes', 'quantityKind', 'tensorOrder', 'unit'].includes(key),
    )
    if (unexpected.length > 0)
      throw new Error(`Calculation input ${path} contains unsupported fields: ${unexpected.join(', ')}.`)
    if (typeof leaf.dtype !== 'string' || !inputDtypes.has(leaf.dtype)) {
      throw new Error(`Calculation input ${path}.dtype is invalid.`)
    }
    const shape = secureShape(leaf.shape, `Calculation input ${path}.shape`)
    if (
      !Number.isInteger(leaf.tensorOrder) ||
      (leaf.tensorOrder as number) < 0 ||
      (leaf.tensorOrder as number) > shape.length
    ) {
      throw new Error(`Calculation input ${path}.tensorOrder is invalid.`)
    }
    const externalShape = shape.slice(0, shape.length - (leaf.tensorOrder as number))
    validateInputAxes(leaf.axes, externalShape, `Calculation input ${path}.axes`)
    const size = shape.reduce((product, length) => product * length, 1)
    if (shape.length === 0) {
      if (!['boolean', 'string', 'number'].includes(typeof leaf.data)) {
        throw new Error(`Calculation input ${path}.data must be scalar.`)
      }
    } else if (
      !Array.isArray(leaf.data) ||
      leaf.data.length !== size ||
      leaf.data.some((item) => !['boolean', 'string', 'number'].includes(typeof item))
    ) {
      throw new Error(`Calculation input ${path}.data must contain ${size} row-major scalar values.`)
    }
    if (leaf.quantityKind !== undefined && typeof leaf.quantityKind !== 'string') {
      throw new Error(`Calculation input ${path}.quantityKind is invalid.`)
    }
    if (leaf.unit !== undefined) {
      if (typeof leaf.unit !== 'string' || leaf.unit.trim() === '')
        throw new Error(`Calculation input ${path}.unit is invalid.`)
      convertUcumValue(1, leaf.unit, leaf.unit, `Calculation input ${path}.unit`)
    }
  })
  const payloadBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (payloadBytes > CALCULATION_INPUT_MAX_BYTES) {
    throw new CalculationExecutionError(
      'input-too-large',
      `Calculation input payload is ${payloadBytes.toLocaleString()} bytes; the limit is ${CALCULATION_INPUT_MAX_BYTES.toLocaleString()} bytes.`,
    )
  }
}

function isMathJsMatrix(value: unknown): value is {
  isMatrix: true
  size: () => unknown
  toArray: () => unknown
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'isMatrix' in value &&
    value.isMatrix === true &&
    'size' in value &&
    typeof value.size === 'function' &&
    'toArray' in value &&
    typeof value.toArray === 'function'
  )
}

function inferOutputShape(value: unknown): readonly number[] {
  if (isMathJsMatrix(value)) return secureShape(value.size(), 'Calculation output Math.js Matrix size')
  if (typeof value === 'number') return Object.freeze([])
  if (!Array.isArray(value)) throw new Error('Calculation output data must be a real scalar, array, or Math.js Matrix.')
  if (value.length === 0) return Object.freeze([0])
  if (value.every((item) => !Array.isArray(item))) return Object.freeze([value.length])
  if (value.some((item) => !Array.isArray(item))) throw new Error('Calculation output data is ragged.')
  const rows = value as readonly unknown[][]
  const columns = rows[0].length
  if (rows.some((row) => row.length !== columns || row.some(Array.isArray))) {
    throw new Error('Calculation output data is ragged or has rank greater than 2.')
  }
  return Object.freeze([rows.length, columns])
}

function flattenOutputData(value: unknown, shape: readonly number[], path: string): number | readonly number[] {
  const matrix = isMathJsMatrix(value) ? value.toArray() : value
  if (shape.length === 0) {
    if (typeof matrix !== 'number') throw new Error(`${path} must be a real scalar.`)
    return matrix
  }
  if (!Array.isArray(matrix)) throw new Error(`${path} must be an array or Math.js Matrix.`)
  if (shape.length === 1) {
    if (matrix.length !== shape[0] || matrix.some(Array.isArray))
      throw new Error(`${path} does not match shape [${shape.join(', ')}].`)
    return Object.freeze([...(matrix as unknown[])]) as readonly number[]
  }
  const size = shape[0] * shape[1]
  if (matrix.every((item) => !Array.isArray(item))) {
    if (matrix.length !== size) throw new Error(`${path} does not match shape [${shape.join(', ')}].`)
    return Object.freeze([...(matrix as unknown[])]) as readonly number[]
  }
  if (
    matrix.length !== shape[0] ||
    matrix.some((row) => !Array.isArray(row) || row.length !== shape[1] || row.some(Array.isArray))
  ) {
    throw new Error(`${path} is ragged or does not match shape [${shape.join(', ')}].`)
  }
  return Object.freeze(matrix.flat()) as readonly number[]
}

function defaultAxes(shape: readonly number[]) {
  const names = shape.length === 1 ? ['index'] : ['row', 'column']
  return Object.freeze(
    shape.map((length, index) =>
      Object.freeze({
        name: names[index],
        ticks: Object.freeze(Array.from({ length }, (_, tick) => tick)),
      }),
    ),
  )
}

export function normalizeCalculationOutput(value: unknown): NormalizedCalculationOutput {
  const output = secureRecord(value, 'Calculation output')
  const unexpected = Object.keys(output).filter((key) => !['dtype', 'data', 'axes'].includes(key))
  if (unexpected.length > 0)
    throw new Error(`Calculation output contains unsupported fields: ${unexpected.join(', ')}.`)
  return normalizeOutputParts(output, inferOutputShape(output.data), true)
}

function normalizeOutputParts(
  output: Record<string, unknown>,
  shape: readonly number[],
  allowMissingAxes: boolean,
): NormalizedCalculationOutput {
  if (!calculationDtypes.includes(output.dtype as (typeof calculationDtypes)[number])) {
    throw new Error('Calculation output dtype is invalid.')
  }
  if (shape.length > 2) throw new Error('Calculation output rank must be 0, 1, or 2.')
  const size = shape.reduce((product, length) => product * length, 1)
  if (size > CALCULATION_OUTPUT_MAX_ELEMENTS) {
    throw new CalculationExecutionError(
      'output-too-large',
      `Calculation output contains ${size.toLocaleString()} elements; the limit is ${CALCULATION_OUTPUT_MAX_ELEMENTS.toLocaleString()}.`,
    )
  }
  const data = flattenOutputData(output.data, shape, 'Calculation output data')
  const values = typeof data === 'number' ? [data] : data
  values.forEach((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) {
      throw new Error(
        'Calculation output data must contain only finite real numbers; Complex, NaN, and Infinity are invalid.',
      )
    }
  })
  const dtype = output.dtype as (typeof calculationDtypes)[number]
  const range = dtype in integerRanges ? integerRanges[dtype as keyof typeof integerRanges] : undefined
  if (range && values.some((item) => !Number.isInteger(item) || item < range[0] || item > range[1])) {
    throw new Error(`Calculation output data contains a value outside the ${dtype} range.`)
  }
  if (dtype === 'float32' && values.some((item) => !Number.isFinite(Math.fround(item)))) {
    throw new Error('Calculation output data contains a value outside the float32 finite range.')
  }
  if (!allowMissingAxes && output.axes === undefined) throw new Error('Normalized Calculation output axes are missing.')
  const axes = output.axes === undefined ? defaultAxes(shape) : validateAxes(output.axes, shape, 'Calculation output axes')
  return Object.freeze({
    dtype,
    shape: Object.freeze([...shape]) as NormalizedCalculationOutput['shape'],
    data,
    axes,
  })
}

export function normalizeCalculationRunnerOutput(value: unknown): NormalizedCalculationOutput {
  const output = secureRecord(value, 'Normalized Calculation output')
  const unexpected = Object.keys(output).filter((key) => !['dtype', 'shape', 'data', 'axes'].includes(key))
  if (unexpected.length > 0) {
    throw new Error(`Normalized Calculation output contains unsupported fields: ${unexpected.join(', ')}.`)
  }
  return normalizeOutputParts(output, secureShape(output.shape, 'Normalized Calculation output shape'), false)
}
