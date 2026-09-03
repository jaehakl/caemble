import { z } from 'zod'
import type {
  CalculationDataAnalysisResponse,
  CalculationDataAnalysisStatus,
  CalculationDataMissingResponse,
  CalculationDataOutput,
  CalculationDataRecord,
  CalculationDataSaveResponse,
  CalculationDataScalar,
  PersistedCalculationRecord,
} from './calculation'
import { databaseIdSchema, parseGetListResponse } from './validators'

const calculationDataDTypeSchema = z.enum(['float32', 'float64', 'int8', 'int16', 'int32', 'uint8', 'uint16', 'uint32'])
const calculationIntegerRanges: Readonly<Partial<Record<CalculationDataOutput['dtype'], readonly [number, number]>>> = {
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
}
const calculationDataAxisSchema = z
  .object({
    name: z.string(),
    ticks: z.array(z.number()),
    unit: z
      .string()
      .nullable()
      .optional()
      .transform((unit) => unit ?? undefined),
  })
  .passthrough()
const calculationOutputLayoutFields = {
  dtype: calculationDataDTypeSchema,
  shape: z.array(z.number().int().nonnegative()).max(2),
  axes: z.array(calculationDataAxisSchema),
}

function validateCalculationOutputLayout(
  value: Readonly<{ shape: readonly number[]; axes: readonly Readonly<{ ticks: readonly number[] }>[] }>,
  context: z.RefinementCtx,
) {
  if (value.axes.length !== value.shape.length) {
    context.addIssue({ code: 'custom', path: ['axes'], message: 'Calculation output axes must match output rank.' })
  }
  value.axes.forEach((axis, index) => {
    if (axis.ticks.length !== value.shape[index]) {
      context.addIssue({
        code: 'custom',
        path: ['axes', index, 'ticks'],
        message: 'Calculation output axis ticks must match output shape.',
      })
    }
  })
  if (value.shape.reduce((size, length) => size * length, 1) > 5_000_000) {
    context.addIssue({ code: 'custom', path: ['shape'], message: 'Calculation output exceeds the element limit.' })
  }
}

export const calculationOutputLayoutSchema = z
  .object(calculationOutputLayoutFields)
  .passthrough()
  .superRefine(validateCalculationOutputLayout)

export const calculationDataOutputSchema = z
  .object({
    ...calculationOutputLayoutFields,
    data: z.union([z.number(), z.array(z.number())]),
  })
  .passthrough()
  .superRefine((value, context) => {
    validateCalculationOutputLayout(value, context)
    const values = Array.isArray(value.data) ? value.data : [value.data]
    const expected = value.shape.reduce((size, length) => size * length, 1)
    if (
      values.length !== expected ||
      (value.shape.length > 0 && !Array.isArray(value.data)) ||
      (value.shape.length === 0 && Array.isArray(value.data))
    ) {
      context.addIssue({ code: 'custom', path: ['data'], message: 'CalculationData data must match output shape.' })
    }
    const integerRange = calculationIntegerRanges[value.dtype]
    if (
      integerRange &&
      values.some((item) => !Number.isInteger(item) || item < integerRange[0] || item > integerRange[1])
    ) {
      context.addIssue({ code: 'custom', path: ['data'], message: `CalculationData values must fit ${value.dtype}.` })
    }
    if (value.dtype === 'float32' && values.some((item) => Math.abs(item) > 3.4028234663852886e38)) {
      context.addIssue({ code: 'custom', path: ['data'], message: 'CalculationData values must fit float32.' })
    }
  })

export const persistedCalculationRecordSchema = z
  .object({
    id: databaseIdSchema,
    experiment_id: databaseIdSchema,
    name: z.string(),
    source_code: z.string(),
    output_layout: calculationOutputLayoutSchema.nullable().optional(),
    contract_status: z.enum(['ready', 'needs_preflight']),
    experiment_record_ids: z.array(databaseIdSchema),
  })
  .passthrough()

export const calculationDataRecordSchema = z
  .object({
    id: databaseIdSchema,
    calculation_id: databaseIdSchema,
    measurement_id: databaseIdSchema,
    data: calculationDataOutputSchema,
  })
  .passthrough()

const calculationDataAnalysisItemSchema = z
  .object({
    calculation_data_id: databaseIdSchema,
    calculation_id: databaseIdSchema,
    calculation_name: z.string(),
    measurement_id: databaseIdSchema,
    dtype: calculationDataDTypeSchema,
    summary: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('scalar'),
          value: z.number(),
        })
        .passthrough(),
      z
        .object({
          kind: z.literal('tensor'),
          rank: z.union([z.literal(1), z.literal(2)]),
          count: z.number().int().nonnegative(),
          mean: z.number().nullable(),
          std: z.number().nullable(),
        })
        .passthrough(),
    ]),
  })
  .passthrough()

const calculationDataAnalysisResponseSchema = z
  .object({
    fingerprint: z.string(),
    total: z.number().int().nonnegative(),
    measurement_count: z.number().int().nonnegative(),
    items: z.array(calculationDataAnalysisItemSchema),
  })
  .passthrough()

const calculationDataAnalysisStatusSchema = z
  .object({
    fingerprint: z.string(),
    total: z.number().int().nonnegative(),
    measurement_count: z.number().int().nonnegative(),
  })
  .passthrough()

const calculationDataScalarSchema = z
  .object({
    measurement_id: databaseIdSchema,
    value: z.number(),
  })
  .passthrough()

const calculationDataTargetSchema = z
  .object({
    calculation_id: databaseIdSchema,
    measurement_id: databaseIdSchema,
  })
  .passthrough()

const calculationDataMissingResponseSchema = z
  .object({
    total: z.number().int().nonnegative(),
    items: z.array(calculationDataTargetSchema),
  })
  .passthrough()

const calculationDataSaveResponseSchema = z
  .object({
    id: databaseIdSchema,
    created: z.boolean(),
  })
  .passthrough()

export function parseCalculationListResponse(value: unknown) {
  return parseGetListResponse<PersistedCalculationRecord>(value, persistedCalculationRecordSchema)
}

export function parseCalculationDataListResponse(value: unknown) {
  return parseGetListResponse<CalculationDataRecord>(value, calculationDataRecordSchema)
}

export function parseCalculationDataAnalysisResponse(value: unknown): CalculationDataAnalysisResponse {
  return calculationDataAnalysisResponseSchema.parse(value) as CalculationDataAnalysisResponse
}

export function parseCalculationDataAnalysisStatus(value: unknown): CalculationDataAnalysisStatus {
  return calculationDataAnalysisStatusSchema.parse(value) as CalculationDataAnalysisStatus
}

export function parseCalculationDataScalarsResponse(value: unknown) {
  return parseGetListResponse<CalculationDataScalar>(value, calculationDataScalarSchema)
}

export function parseCalculationDataMissingResponse(value: unknown): CalculationDataMissingResponse {
  return calculationDataMissingResponseSchema.parse(value) as CalculationDataMissingResponse
}

export function parseCalculationDataSaveResponse(value: unknown): CalculationDataSaveResponse {
  return calculationDataSaveResponseSchema.parse(value) as CalculationDataSaveResponse
}
