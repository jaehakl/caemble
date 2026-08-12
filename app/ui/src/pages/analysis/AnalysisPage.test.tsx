import { describe, expect, it } from 'vitest'
import pageSource from './AnalysisPage.tsx?raw'
import workerSource from './analysis.worker.ts?raw'

describe('integrated Measurement analysis UI', () => {
  it('scopes loading to one Experiment', () => {
    expect(pageSource).toContain('experimentId: number | null')
    expect(pageSource).not.toContain('structureId: number | null')
    expect(workerSource).toContain('filter: { experiment_id: [experimentId, experimentId] }')
  })

  it('profiles prepared and recorded Measurement counts without Sample or Setup identity', () => {
    expect(pageSource).toContain('profile.preparedCount')
    expect(pageSource).toContain('profile.recordedMeasurementCount')
    expect(pageSource).toContain('inputFingerprint')
    expect(pageSource).not.toContain('sampleId')
    expect(pageSource).not.toContain('setupId')
  })
})
