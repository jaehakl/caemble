import { z } from 'zod'
import { predictionNumericDtypes } from './types'
import { predictionTensorValueCount } from './tensor'
import { assertBoxGridData, type BoxGridData } from '@/contracts/boxGrid'

const nonnegativeIntegerSchema = z.number().int().nonnegative()
const positiveIntegerSchema = z.number().int().positive()
const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, 'Expected a non-empty string.')

function isFiniteNumberArray(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'number' || !Number.isFinite(value[index])) return false
  }
  return true
}

const finiteNumberArraySchema = z.custom<readonly number[]>(isFiniteNumberArray, 'Expected an array of finite numbers.')
const predictionAxisSchema = z
  .object({
    name: nonBlankStringSchema,
    ticks: z.array(z.union([z.number(), z.string()])),
    unit: nonBlankStringSchema.optional(),
  })
  .passthrough()

export const predictionTensorLayoutSchema = z
  .object({
    key: nonBlankStringSchema,
    dtype: z.enum(predictionNumericDtypes),
    shape: z.array(nonnegativeIntegerSchema),
    axes: z.array(predictionAxisSchema).optional(),
    dataSchemaSignature: nonBlankStringSchema.optional(),
    tensorOrder: nonnegativeIntegerSchema.optional(),
    unit: nonBlankStringSchema.optional(),
    quantityKind: nonBlankStringSchema.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    boxGrid: z
      .custom<BoxGridData>((value) => {
        try {
          assertBoxGridData(value)
          return true
        } catch {
          return false
        }
      })
      .optional(),
    frequencyOutput: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((layout, context) => {
    const tensorOrder = layout.tensorOrder ?? 0
    if (tensorOrder > layout.shape.length) {
      context.addIssue({
        code: 'custom',
        path: ['tensorOrder'],
        message: 'Tensor order must not exceed the shape rank.',
      })
    }
    if ((layout.minimum === undefined) !== (layout.maximum === undefined)) {
      context.addIssue({ code: 'custom', path: ['minimum'], message: 'Tensor bounds must be provided together.' })
    } else if (layout.minimum !== undefined && layout.maximum !== undefined && layout.minimum > layout.maximum) {
      context.addIssue({
        code: 'custom',
        path: ['minimum'],
        message: 'Tensor minimum must not exceed its maximum.',
      })
    }
    const externalRank = layout.boxGrid ? layout.shape.length : Math.max(0, layout.shape.length - tensorOrder)
    if (layout.axes !== undefined && layout.axes.length !== externalRank) {
      context.addIssue({ code: 'custom', path: ['axes'], message: 'Tensor axes must match the external shape rank.' })
      return
    }
    layout.axes?.forEach((axis, index) => {
      if (axis.ticks.length !== layout.shape[index]) {
        context.addIssue({
          code: 'custom',
          path: ['axes', index, 'ticks'],
          message: 'Axis ticks must match the corresponding shape dimension.',
        })
      }
    })
  })

function tensorSampleSchema(valuesSchema: z.ZodType<readonly number[]>) {
  return z
    .object({
      layout: predictionTensorLayoutSchema,
      values: valuesSchema,
    })
    .passthrough()
    .superRefine((sample, context) => {
      let size: number
      try {
        size = predictionTensorValueCount(sample.layout)
      } catch {
        context.addIssue({ code: 'custom', path: ['layout', 'shape'], message: 'Tensor shape is too large.' })
        return
      }
      if (sample.values.length !== size) {
        context.addIssue({
          code: 'custom',
          path: ['values'],
          message: 'Tensor values must match the declared shape and dtype.',
        })
      }
    })
}

export const predictionTensorSampleSchema = tensorSampleSchema(finiteNumberArraySchema)
const exclusionReasonSchema = z.enum([
  'missing-block',
  'extra-block',
  'invalid-tensor',
  'fixed-layout-mismatch',
  'layout-mismatch',
])

export const legacyCohortDiagnosticSchema = z
  .object({
    direction: z.enum(['forward', 'inverse']),
    disposition: z.enum(['included-with-warning', 'excluded']),
    reason: z.union([exclusionReasonSchema, z.literal('metadata-mismatch')]),
    side: z.enum(['input', 'output']),
    blockKey: z.string(),
    fieldPath: z.string(),
    baselineMeasurementId: positiveIntegerSchema.nullable(),
    expected: z.string(),
    actual: z.string(),
    measurementIds: z.array(positiveIntegerSchema),
    mismatchCount: nonnegativeIntegerSchema.optional(),
    firstMismatchIndex: nonnegativeIntegerSchema.optional(),
    maxAbsoluteDifference: z.number().nonnegative().optional(),
  })
  .passthrough()

export const exclusionCountsSchema = z
  .object({
    'missing-block': nonnegativeIntegerSchema,
    'extra-block': nonnegativeIntegerSchema,
    'invalid-tensor': nonnegativeIntegerSchema,
    'fixed-layout-mismatch': nonnegativeIntegerSchema,
    'layout-mismatch': nonnegativeIntegerSchema,
  })
  .passthrough()

export const predictionNeighborSchema = z
  .object({
    measurementId: positiveIntegerSchema,
    distanceSquared: z.number().nonnegative(),
    weight: z.number().nonnegative(),
  })
  .passthrough()

export const queryDiagnosticSchema = z
  .object({
    blockKey: z.string(),
    fieldPath: z.string(),
    expected: z.string(),
    actual: z.string(),
    mismatchCount: nonnegativeIntegerSchema.optional(),
    firstMismatchIndex: nonnegativeIntegerSchema.optional(),
    maxAbsoluteDifference: z.number().nonnegative().optional(),
  })
  .passthrough()

export const cohortDiagnosticSchema = legacyCohortDiagnosticSchema.extend({ direction: z.literal('forward') })
