import { z } from 'zod'
import type {
  PersistedMaterialNameRecord,
  PersistedMaterialParameterQualifierRecord,
  PersistedMaterialParameterRecord,
  PersistedMaterialRecord,
} from './materials'
import { databaseIdSchema, parseGetListResponse } from './validators'

export const persistedMaterialRecordSchema = z.object({ id: databaseIdSchema }).passthrough()

export const persistedMaterialNameRecordSchema = z
  .object({
    id: databaseIdSchema,
    material_id: databaseIdSchema,
    name: z.string(),
  })
  .passthrough()

export const persistedMaterialParameterRecordSchema = z
  .object({
    id: databaseIdSchema,
    material_id: databaseIdSchema,
    name: z.string(),
    value: z.json(),
  })
  .passthrough()

export const persistedMaterialParameterQualifierRecordSchema = z
  .object({
    id: databaseIdSchema,
    material_parameter_id: databaseIdSchema,
    name: z.string(),
    value: z.number(),
  })
  .passthrough()

export function parseMaterialListResponse(value: unknown) {
  return parseGetListResponse<PersistedMaterialRecord>(value, persistedMaterialRecordSchema)
}

export function parseMaterialNameListResponse(value: unknown) {
  return parseGetListResponse<PersistedMaterialNameRecord>(value, persistedMaterialNameRecordSchema)
}

export function parseMaterialParameterListResponse(value: unknown) {
  return parseGetListResponse<PersistedMaterialParameterRecord>(value, persistedMaterialParameterRecordSchema)
}

export function parseMaterialParameterQualifierListResponse(value: unknown) {
  return parseGetListResponse<PersistedMaterialParameterQualifierRecord>(
    value,
    persistedMaterialParameterQualifierRecordSchema,
  )
}
