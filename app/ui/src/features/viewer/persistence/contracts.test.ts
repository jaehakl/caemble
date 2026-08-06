import { describe, expect, it } from 'vitest'
import { createSampleRecord, createSetupRecord } from './contracts'

describe('Viewer realization persistence contracts', () => {
  const materials = { schemaVersion: 1, materials: {} } as const

  it('stores evaluated Sample vars and its frozen Material snapshot', () => {
    expect(createSampleRecord(17, { width: 2, origin: [0, 1, 2] }, materials)).toEqual({
      structure_id: 17,
      vars: { width: 2, origin: [0, 1, 2] },
      material_parameters: materials,
    })
  })

  it('stores evaluated Setup vars against its saved Experiment', () => {
    expect(createSetupRecord(23, { voltage: 5 }, materials)).toEqual({
      experiment_id: 23,
      vars: { voltage: 5 },
      material_parameters: materials,
    })
  })
})
