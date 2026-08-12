import { describe, expect, it } from 'vitest'
import { createMeasurementRecord, readMeasurementMaterialParameters } from './contracts'

describe('Measurement persistence contracts', () => {
  const materials = { schemaVersion: 1, materials: {} } as const

  it('stores complete vars and common/Task frozen materials against one Experiment revision', () => {
    expect(
      createMeasurementRecord(23, 'e'.repeat(64), { voltage: 5 }, materials, { Electrostatics: materials }),
    ).toEqual({
      experiment_id: 23,
      experiment_source_hash: 'e'.repeat(64),
      vars: { voltage: 5 },
      material_parameters: {
        schemaVersion: 2,
        experiment: materials,
        tasks: { Electrostatics: materials },
      },
    })
  })

  it('accepts only the exact schema-v2 Task material set', () => {
    const snapshot = { schemaVersion: 2, experiment: materials, tasks: { Heat: materials } }
    expect(readMeasurementMaterialParameters(snapshot, ['Heat'])).toEqual(snapshot)
    expect(readMeasurementMaterialParameters(snapshot, ['Heat', 'Flow'])).toBeNull()
    expect(readMeasurementMaterialParameters({ ...snapshot, schemaVersion: 1 }, ['Heat'])).toBeNull()
  })
})
