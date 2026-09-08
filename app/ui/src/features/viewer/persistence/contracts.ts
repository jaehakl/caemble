import type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'
export type { MeasurementMaterialSnapshot } from '@/contracts/api/measurement'

export function readMeasurementMaterialSnapshot(
  value: unknown,
  _taskNames?: readonly string[],
): MeasurementMaterialSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const snapshot = value as MeasurementMaterialSnapshot
  if (
    !snapshot.experiment?.materials ||
    !snapshot.tasks ||
    !snapshot.sourceHash ||
    !snapshot.varsHash ||
    !Array.isArray(snapshot.modelDefinitions) ||
    !snapshot.selections
  )
    throw new Error('Saved Material snapshot uses an unsupported contract.')
  return snapshot
}
