import type { MeasurementCreateRequest } from '@/api'
import type { FrozenMaterialParameters } from '@/lib/material'

export type MeasurementMaterialParameters = Readonly<{
  experiment: FrozenMaterialParameters
  tasks: Readonly<Record<string, FrozenMaterialParameters>>
}>

export function readMeasurementMaterialParameters(
  value: unknown,
  _taskNames?: readonly string[],
): MeasurementMaterialParameters | null {
  void _taskNames
  return value as MeasurementMaterialParameters
}

export function createMeasurementRecord(
  experimentId: number,
  experimentSourceHash: string,
  variables: Readonly<Record<string, unknown>>,
  experimentMaterials: FrozenMaterialParameters,
  taskMaterials: Readonly<Record<string, FrozenMaterialParameters>>,
): MeasurementCreateRequest {
  return {
    experiment_id: experimentId,
    experiment_source_hash: experimentSourceHash,
    vars: { ...variables },
    material_parameters: {
      experiment: experimentMaterials,
      tasks: { ...taskMaterials },
    },
  }
}
