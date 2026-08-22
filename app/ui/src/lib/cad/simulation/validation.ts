import { getQuantityKindTensorOrder, normalizeQuantityMetadata } from '../../quantitykind/runtime'
import type { ResolvedDataSchema, SimulationProgramManifest } from './types'

const dataDTypes = new Set([
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const invalid = Reflect.ownKeys(value).filter((key) => typeof key !== 'string' || !keys.includes(key))
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (invalid.length > 0 || missing.length > 0) {
    throw new Error(`${path} must contain exactly ${keys.join(', ')}.`)
  }
}

function assertRecordedDataSpec(value: unknown, path: string): asserts value is ResolvedDataSchema {
  if (
    !isPlainObject(value) ||
    typeof value.dtype !== 'string' ||
    !dataDTypes.has(value.dtype) ||
    !Number.isSafeInteger(value.tensorOrder) ||
    (value.tensorOrder as number) < 0
  ) {
    throw new Error(`${path} must declare a supported dtype and tensorOrder.`)
  }
  const keys = ['dtype', 'tensorOrder']
  if (value.unit !== undefined) keys.push('unit')
  if (value.quantityKind !== undefined) keys.push('quantityKind')
  if (value.basis !== undefined) keys.push('basis')
  if (value.axes !== undefined) keys.push('axes')
  assertExactKeys(value, keys, path)

  if (value.dtype.startsWith('float')) {
    const metadata = normalizeQuantityMetadata(value, path)
    if (value.tensorOrder !== getQuantityKindTensorOrder(metadata.quantityKind)) {
      throw new Error(`${path}.tensorOrder does not match its QuantityKind.`)
    }
  } else {
    if (value.tensorOrder !== 0) throw new Error(`${path}.tensorOrder must be 0 for non-float data.`)
    if (value.unit !== undefined || value.quantityKind !== undefined || value.basis !== undefined) {
      throw new Error(`${path} quantity metadata is allowed only for float dtypes.`)
    }
  }

  if (value.axes === undefined) return
  if (!Array.isArray(value.axes) || value.axes.length === 0) {
    throw new Error(`${path}.axes must be a non-empty array when specified.`)
  }
  value.axes.forEach((axis, index) => {
    const axisPath = `${path}.axes[${index}]`
    if (!isPlainObject(axis)) throw new Error(`${axisPath} must be an object.`)
    const axisKeys = ['length', 'name', 'ticks', 'unit', 'quantityKind'].filter((key) => axis[key] !== undefined)
    assertExactKeys(axis, axisKeys, axisPath)
    if (axis.length !== undefined && (!Number.isSafeInteger(axis.length) || (axis.length as number) <= 0)) {
      throw new Error(`${axisPath}.length must be a positive safe integer.`)
    }
    if (axis.ticks !== undefined) {
      if (!Array.isArray(axis.ticks) || axis.length === undefined || axis.ticks.length !== axis.length) {
        throw new Error(`${axisPath}.ticks must match its fixed axis length.`)
      }
      if (axis.ticks.some((tick) => typeof tick !== 'string' && (typeof tick !== 'number' || !Number.isFinite(tick)))) {
        throw new Error(`${axisPath}.ticks must contain only finite numbers or strings.`)
      }
    }
    const hasUnit = axis.unit !== undefined
    const hasQuantityKind = axis.quantityKind !== undefined
    if (hasUnit !== hasQuantityKind) {
      throw new Error(`${axisPath} must specify unit and QuantityKind together.`)
    }
    if (hasUnit) normalizeQuantityMetadata(axis, axisPath, true)
  })
}

export function assertSimulationProgramManifest(
  value: unknown,
  options: Readonly<{ allowTaskless?: boolean }> = {},
): asserts value is SimulationProgramManifest {
  if (
    !isPlainObject(value) ||
    value.formatVersion !== 5 ||
    value.simulationApiVersion !== 3 ||
    typeof value.pythonSource !== 'string' ||
    !value.pythonSource.trim() ||
    !isPlainObject(value.tasks) ||
    (!options.allowTaskless && Object.keys(value.tasks).length === 0) ||
    !isPlainObject(value.recordedData)
  ) {
    throw new Error('Simulation Program manifest is invalid.')
  }
  assertExactKeys(
    value,
    ['formatVersion', 'simulationApiVersion', 'pythonSource', 'tasks', 'recordedData'],
    'Simulation Program manifest',
  )

  Object.entries(value.tasks).forEach(([taskName, task]) => {
    if (
      !taskName.trim() ||
      !isPlainObject(task) ||
      !isPlainObject(task.kernel) ||
      typeof task.kernel.name !== 'string' ||
      !task.kernel.name.trim() ||
      typeof task.kernel.version !== 'string' ||
      !task.kernel.version.trim() ||
      !isPlainObject(task.config)
    ) {
      throw new Error(`Simulation Program task "${taskName}" is invalid.`)
    }
    assertExactKeys(task, ['kernel', 'config'], `Simulation Program task "${taskName}"`)
    assertExactKeys(task.kernel, ['name', 'version'], `Simulation Program task "${taskName}".kernel`)
  })

  Object.entries(value.recordedData).forEach(([name, spec]) => {
    if (!name.trim()) throw new Error('RecordedData names must not be empty.')
    assertRecordedDataSpec(spec, `Simulation Program recordedData "${name}"`)
  })
}
