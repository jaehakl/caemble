import {
  CadModelError,
  normalizeDataElement,
  type CartesianBasis,
  type DataDType,
  type QuantityKindName,
  type RecordedData,
  type RecordedDataRule,
  type RecordedDataTensor,
} from './core'
import { createDataTensorAccessor, isDataTensor, type DataTensorAccessor } from './dataTensor'
import { getQuantityKindComponentShape, getQuantityKindTensorOrder } from '../../quantitykind/runtime'
import type { UcumUnit } from './units'

export type ResolvedRecordedTensor = Readonly<{
  value: boolean | string | number | readonly unknown[]
  accessor: DataTensorAccessor
  componentShape: readonly 3[]
  tensorOrder: number
  dtype: DataDType
  axes: readonly Readonly<{
    length: number
    name: string
    ticks: readonly (number | string)[]
  }>[]
  unit?: UcumUnit
  quantityKind?: QuantityKindName
  basis?: CartesianBasis
}>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function describeTensorShape(value: unknown, ancestors = new Set<unknown>()): string {
  if (!Array.isArray(value)) return '[]'
  if (ancestors.has(value)) return '[circular]'
  if (value.length === 0) return '[0]'

  ancestors.add(value)
  const childShapes = value.map((item) => describeTensorShape(item, ancestors))
  ancestors.delete(value)
  const uniqueShapes = [...new Set(childShapes)]
  if (uniqueShapes.length !== 1) return `[${value.length}, ragged ${uniqueShapes.join(' | ')}]`
  const child = uniqueShapes[0]
  return child === '[]' ? `[${value.length}]` : `[${value.length}, ${child.slice(1, -1)}]`
}

function recordedShapeError(path: string, value: unknown, expectedShape: readonly number[]) {
  return new CadModelError(
    `${path} has actual shape ${describeTensorShape(value)}; expected shape ${JSON.stringify(expectedShape)}.`,
  )
}

function resolveActualShape(
  value: unknown,
  expectedShape: readonly number[],
  path: string,
  rootValue = value,
  depth = 0,
  ancestors = new Set<unknown>(),
): readonly number[] {
  if (depth === expectedShape.length) {
    if (Array.isArray(value)) throw recordedShapeError(path, rootValue, expectedShape)
    return Object.freeze([])
  }
  if (!Array.isArray(value) || ancestors.has(value)) {
    throw recordedShapeError(path, rootValue, expectedShape)
  }

  const expectedSize = expectedShape[depth]
  if (expectedSize !== -1 && value.length !== expectedSize) {
    throw recordedShapeError(path, rootValue, expectedShape)
  }
  if (value.length === 0) {
    return Object.freeze([0, ...expectedShape.slice(depth + 1).map((size) => (size === -1 ? 0 : size))])
  }

  ancestors.add(value)
  const childShapes = value.map((item) =>
    resolveActualShape(item, expectedShape, path, rootValue, depth + 1, ancestors),
  )
  ancestors.delete(value)
  const firstShape = childShapes[0]
  if (childShapes.some((shape) => JSON.stringify(shape) !== JSON.stringify(firstShape))) {
    throw recordedShapeError(path, rootValue, expectedShape)
  }
  return Object.freeze([value.length, ...firstShape])
}

function normalizeRecordedValue(
  value: unknown,
  shape: readonly number[],
  dtype: DataDType,
  path: string,
  depth = 0,
  copy = true,
): boolean | string | number | readonly unknown[] {
  if (depth === shape.length) return normalizeDataElement(value, dtype, path)
  const values = value as readonly unknown[]
  if (!copy) {
    values.forEach((item, index) => {
      normalizeRecordedValue(item, shape, dtype, `${path}[${index}]`, depth + 1, false)
    })
    return values
  }
  return Object.freeze(
    values.map((item, index) => normalizeRecordedValue(item, shape, dtype, `${path}[${index}]`, depth + 1, true)),
  )
}

function normalizePayloadAxes(value: unknown, rule: RecordedDataRule, actualShape: readonly number[], path: string) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new CadModelError(`${path}.axes must be an array.`)
  }
  const schemaAxes = rule.result.axes ?? []
  if (Array.isArray(value) && value.length === 0 && schemaAxes.length === 0) {
    throw new CadModelError(`${path}.axes must be omitted when the result has no axes.`)
  }
  const rawAxes = value ?? Array.from({ length: schemaAxes.length }, () => ({}))
  if ((rawAxes as readonly unknown[]).length !== schemaAxes.length) {
    throw new CadModelError(
      `${path}.axes has length ${(rawAxes as readonly unknown[]).length}; expected ${schemaAxes.length}.`,
    )
  }

  return Object.freeze(
    Array.from(rawAxes as readonly unknown[], (rawAxis, axisIndex) => {
      const axisPath = `${path}.axes[${axisIndex}]`
      if (!isPlainObject(rawAxis)) throw new CadModelError(`${axisPath} must be a plain object.`)
      const keys = Reflect.ownKeys(rawAxis)
      if (keys.some((key) => key !== 'ticks')) {
        throw new CadModelError(`${axisPath} may contain only ticks.`)
      }

      const schemaAxis = schemaAxes[axisIndex]
      const schemaTicks =
        schemaAxis?.ticks ??
        (schemaAxis?.length === undefined
          ? undefined
          : Array.from({ length: actualShape[axisIndex] }, (_, index) => index))
      const rawTicks =
        rawAxis.ticks ?? schemaTicks ?? Array.from({ length: actualShape[axisIndex] }, (_, index) => index)
      if (!Array.isArray(rawTicks)) throw new CadModelError(`${axisPath}.ticks must be an array.`)
      if (rawTicks.length !== actualShape[axisIndex]) {
        throw new CadModelError(
          `${axisPath}.ticks has length ${rawTicks.length}; expected actual axis length ${actualShape[axisIndex]}.`,
        )
      }
      const ticks = Object.freeze(
        Array.from(rawTicks, (tick, tickIndex) => {
          if (typeof tick === 'string' || (typeof tick === 'number' && Number.isFinite(tick))) return tick
          throw new CadModelError(`${axisPath}.ticks[${tickIndex}] must be a string or finite number.`)
        }),
      )
      if (
        schemaAxis?.length !== undefined &&
        rawAxis.ticks !== undefined &&
        JSON.stringify(ticks) !== JSON.stringify(schemaTicks)
      ) {
        throw new CadModelError(
          `${axisPath}.ticks ${JSON.stringify(ticks)} does not match Experiment schema ticks ${JSON.stringify(schemaTicks)}.`,
        )
      }

      return Object.freeze({
        length: actualShape[axisIndex],
        name: schemaAxis?.name ?? `axis ${axisIndex}`,
        ticks,
      })
    }),
  )
}

function resolveRecordedDataTensor(rule: RecordedDataRule, value: unknown, copyValue: boolean): ResolvedRecordedTensor {
  const path = `recordedData[${JSON.stringify(rule.label)}]`
  if (isDataTensor(value)) {
    const accessor = createDataTensorAccessor(rule.result, value, path)
    const axisCount = rule.result.axes?.length ?? 0
    const componentShape =
      rule.result.quantityKind === undefined
        ? (Object.freeze([]) as readonly 3[])
        : getQuantityKindComponentShape(rule.result.quantityKind)
    const tensorOrder =
      rule.result.quantityKind === undefined ? 0 : getQuantityKindTensorOrder(rule.result.quantityKind)
    const resolved = {
      axes: Object.freeze(
        Array.from({ length: axisCount }, (_, axisIndex) =>
          Object.freeze({
            length: accessor.shape[axisIndex],
            name: rule.result.axes?.[axisIndex]?.name ?? `axis ${axisIndex}`,
            ticks:
              accessor.tensor.axes?.[axisIndex]?.ticks ??
              Object.freeze(Array.from({ length: accessor.shape[axisIndex] }, (_, index) => index)),
          }),
        ),
      ),
      componentShape,
      tensorOrder,
      dtype: rule.result.dtype,
      ...(rule.result.unit === undefined ? {} : { unit: rule.result.unit }),
      ...(rule.result.quantityKind === undefined ? {} : { quantityKind: rule.result.quantityKind }),
      ...(rule.result.basis === undefined ? {} : { basis: rule.result.basis }),
    }
    return Object.freeze(
      Object.defineProperties(resolved, {
        accessor: { value: accessor },
        value: {
          enumerable: true,
          get: () => accessor.materialize(),
        },
      }),
    ) as ResolvedRecordedTensor
  }
  if (!isPlainObject(value)) throw new CadModelError(`${path} must be a plain object containing value.`)
  const obsoleteField = ['type', 'shape', 'dimension', 'sampleDimension', 'sampleShape', 'sampleAxes'].find((field) =>
    Object.prototype.hasOwnProperty.call(value, field),
  )
  if (obsoleteField) {
    const replacement =
      obsoleteField === 'sampleAxes'
        ? `use ${path}.axes`
        : 'omit it; axis lengths are defined by the result schema or inferred from value'
    throw new CadModelError(`${path}.${obsoleteField} is obsolete in the dtype/axes contract; ${replacement}.`)
  }
  const keys = Reflect.ownKeys(value)
  if (!Object.prototype.hasOwnProperty.call(value, 'value') || keys.some((key) => key !== 'value' && key !== 'axes')) {
    throw new CadModelError(`${path} must contain value and optional axes only.`)
  }

  const componentShape =
    rule.result.quantityKind === undefined
      ? (Object.freeze([]) as readonly 3[])
      : getQuantityKindComponentShape(rule.result.quantityKind)
  const tensorOrder = rule.result.quantityKind === undefined ? 0 : getQuantityKindTensorOrder(rule.result.quantityKind)
  const expectedOuterShape = Object.freeze((rule.result.axes ?? []).map((axis) => axis.length ?? -1))
  const storageShape = Object.freeze([...expectedOuterShape, ...componentShape])
  const actualStorageShape = resolveActualShape(value.value, storageShape, `${path}.value`)
  const actualOuterShape = Object.freeze(actualStorageShape.slice(0, expectedOuterShape.length))
  const normalizedValue = normalizeRecordedValue(
    value.value,
    actualStorageShape,
    rule.result.dtype,
    `${path}.value`,
    0,
    copyValue,
  )
  const axes = normalizePayloadAxes(value.axes, rule, actualOuterShape, path)
  const accessor = createDataTensorAccessor(
    rule.result,
    {
      shape: actualStorageShape,
      ...(axes.length === 0 ? {} : { axes: axes.map((axis) => Object.freeze({ ticks: axis.ticks })) }),
      storage: { kind: 'inline', value: normalizedValue },
    },
    path,
  )
  const resolved = {
    axes,
    componentShape,
    tensorOrder,
    dtype: rule.result.dtype,
    ...(rule.result.unit === undefined ? {} : { unit: rule.result.unit }),
    ...(rule.result.quantityKind === undefined ? {} : { quantityKind: rule.result.quantityKind }),
    ...(rule.result.basis === undefined ? {} : { basis: rule.result.basis }),
    value: normalizedValue,
  }
  return Object.freeze(Object.defineProperty(resolved, 'accessor', { value: accessor })) as ResolvedRecordedTensor
}

export function normalizeRecordedDataTensor(rule: RecordedDataRule, value: unknown): ResolvedRecordedTensor {
  return resolveRecordedDataTensor(rule, value, true)
}

export function assertRecordedDataTensor(rule: RecordedDataRule, value: unknown): asserts value is RecordedDataTensor {
  resolveRecordedDataTensor(rule, value, false)
}

export function normalizeRecordedData(rules: readonly RecordedDataRule[], value: unknown): RecordedData {
  if (!isPlainObject(value)) {
    throw new CadModelError('recordedData must be a plain object keyed by recorded rule label.')
  }

  const labels = new Set(rules.map((rule) => rule.label))
  const unknownLabels = Reflect.ownKeys(value).filter((label) => typeof label !== 'string' || !labels.has(label))
  if (unknownLabels.length > 0) {
    throw new CadModelError(`recordedData contains unknown labels: ${unknownLabels.map(String).join(', ')}.`)
  }
  const missingLabels = rules.filter((rule) => !Object.prototype.hasOwnProperty.call(value, rule.label))
  if (missingLabels.length > 0) {
    throw new CadModelError(`recordedData is missing labels: ${missingLabels.map((rule) => rule.label).join(', ')}.`)
  }

  const normalized = rules.map((rule) => {
    const tensor = normalizeRecordedDataTensor(rule, value[rule.label])
    return [
      rule.label,
      Object.freeze({
        value: tensor.value,
        ...(tensor.axes.length === 0
          ? {}
          : {
              axes: Object.freeze(tensor.axes.map((axis) => Object.freeze({ ticks: axis.ticks }))),
            }),
      }),
    ] as const
  })
  return Object.freeze(Object.fromEntries(normalized))
}
