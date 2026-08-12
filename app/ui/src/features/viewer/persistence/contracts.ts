import type { MeasurementCreateRequest } from '@/api'
import type { FrozenMaterialParameters } from '@/lib/material'
import { readFrozenMaterialParameters } from '@/lib/material'

export type MeasurementMaterialParameters = Readonly<{
  schemaVersion: 2
  experiment: FrozenMaterialParameters
  tasks: Readonly<Record<string, FrozenMaterialParameters>>
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readMeasurementMaterialParameters(
  value: unknown,
  taskNames?: readonly string[],
): MeasurementMaterialParameters | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !readFrozenMaterialParameters(value.experiment) ||
    !isRecord(value.tasks)
  ) {
    return null
  }
  const tasks = value.tasks as Record<string, unknown>
  const names = Object.keys(tasks)
  if (
    names.some((name) => !readFrozenMaterialParameters(tasks[name])) ||
    (taskNames !== undefined &&
      (names.length !== taskNames.length || taskNames.some((name) => !(name in tasks))))
  ) {
    return null
  }
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
      schemaVersion: 2,
      experiment: experimentMaterials,
      tasks: { ...taskMaterials },
    },
  }
}
