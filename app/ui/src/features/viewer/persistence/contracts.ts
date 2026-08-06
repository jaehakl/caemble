import type { SampleRecord, SetupRecord } from '@/api'
import type { FrozenMaterialParameters } from '@/lib/material'

export function createSampleRecord(
  structureId: number,
  variables: Readonly<Record<string, unknown>>,
  materialParameters: FrozenMaterialParameters,
): SampleRecord {
  return { structure_id: structureId, vars: { ...variables }, material_parameters: materialParameters }
}

export function createSetupRecord(
  experimentId: number,
  variables: Readonly<Record<string, unknown>>,
  materialParameters: FrozenMaterialParameters,
): SetupRecord {
  return { experiment_id: experimentId, vars: { ...variables }, material_parameters: materialParameters }
}
