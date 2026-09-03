type MaterialWriteRecord = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  inchi?: string | null
  description?: string | null
  color?: string | null
}>

export type MaterialUpsertInput = MaterialWriteRecord & Readonly<{ id?: number }>
export type PersistedMaterialRecord = MaterialWriteRecord & Readonly<{ id: number }>
/** Compatibility alias. Prefer PersistedMaterialRecord for reads and MaterialUpsertInput for writes. */
export type MaterialRecord = MaterialUpsertInput

type MaterialNameWriteRecord = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  material_id: number
  name: string
}>

export type MaterialNameUpsertInput = MaterialNameWriteRecord & Readonly<{ id?: number }>
export type PersistedMaterialNameRecord = MaterialNameWriteRecord & Readonly<{ id: number }>
/** Compatibility alias. Prefer PersistedMaterialNameRecord for reads and MaterialNameUpsertInput for writes. */
export type MaterialNameRecord = MaterialNameUpsertInput

type MaterialParameterWriteRecord = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  user_id?: string | null
  material_id: number
  name: string
  value: unknown | null
  source?: string | null
  version?: string | null
  description?: string | null
  temperature?: number | null
  pressure?: number | null
  frequency?: number | null
}>

export type MaterialParameterUpsertInput = MaterialParameterWriteRecord & Readonly<{ id?: number }>
export type PersistedMaterialParameterRecord = MaterialParameterWriteRecord & Readonly<{ id: number }>
/** Compatibility alias. Prefer PersistedMaterialParameterRecord for reads and MaterialParameterUpsertInput for writes. */
export type MaterialParameterRecord = MaterialParameterUpsertInput

type MaterialParameterQualifierWriteRecord = Readonly<{
  created_at?: string | null
  updated_at?: string | null
  material_parameter_id: number
  name: string
  value: number
}>

export type MaterialParameterQualifierUpsertInput = MaterialParameterQualifierWriteRecord & Readonly<{ id?: number }>
export type PersistedMaterialParameterQualifierRecord = MaterialParameterQualifierWriteRecord & Readonly<{ id: number }>
/** Compatibility alias. Prefer PersistedMaterialParameterQualifierRecord for reads and MaterialParameterQualifierUpsertInput for writes. */
export type MaterialParameterQualifierRecord = MaterialParameterQualifierUpsertInput
