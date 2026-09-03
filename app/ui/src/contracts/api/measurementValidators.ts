import { z } from 'zod'
import type {
  MeasurementRecordedData,
  MeasurementRecordedDataLeaf,
  MeasurementRecordedDataNode,
  PersistedMeasurementRecord,
  PersistedRecordedDataRecord,
} from './measurement'
import { databaseIdSchema, parseGetListResponse } from './validators'

const objectSchema = z.object({}).passthrough()
const recordedDataNameSegmentSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u)

export const measurementRecordedDataLeafSchema: z.ZodType<MeasurementRecordedDataLeaf> = z
  .object({
    experiment_record_id: databaseIdSchema,
    quantity_kind: z.string().nullable(),
    tensor_order: z.number().int().nonnegative(),
    dtype: z.string(),
    data_schema: objectSchema.nullable(),
    data: z.unknown(),
  })
  .passthrough()

const measurementRecordedDataNodeSchema: z.ZodType<MeasurementRecordedDataNode> = z.lazy(() =>
  z.union([measurementRecordedDataLeafSchema, measurementRecordedDataSchema]),
)

export const measurementRecordedDataSchema: z.ZodType<MeasurementRecordedData> = z.record(
  recordedDataNameSegmentSchema,
  measurementRecordedDataNodeSchema,
)

const measurementRecordedDataResponseSchema = z.object({ recorded_data: measurementRecordedDataSchema }).passthrough()

export const persistedMeasurementRecordSchema = z
  .object({
    id: databaseIdSchema,
    experiment_id: databaseIdSchema,
    vars: objectSchema,
    material_parameters: objectSchema,
    recorded_at: z.string().nullable(),
    calculation_data_count: z.number().int().nonnegative(),
  })
  .passthrough()

export const persistedRecordedDataRecordSchema = z
  .object({
    id: databaseIdSchema,
    measurement_id: databaseIdSchema,
    experiment_record_id: databaseIdSchema,
    name: z.string(),
    quantity_kind: z.string().nullable(),
    tensor_order: z.number().int().nonnegative(),
    dtype: z.string(),
  })
  .passthrough()

export function parseMeasurementListResponse(value: unknown) {
  return parseGetListResponse<PersistedMeasurementRecord>(value, persistedMeasurementRecordSchema)
}

export function parseRecordedDataListResponse(value: unknown) {
  return parseGetListResponse<PersistedRecordedDataRecord>(value, persistedRecordedDataRecordSchema)
}

export function parseMeasurementRecordedDataResponse(
  value: unknown,
): Readonly<{ recorded_data: MeasurementRecordedData }> {
  return measurementRecordedDataResponseSchema.parse(value)
}
