import { describe, expect, it } from 'vitest'
import { parseAnalysisWorkerRequest, parseAnalysisWorkerResponse } from './analysisProtocol'

describe('Analysis Worker protocol', () => {
  it('rejects malformed inbound requests before running analysis', () => {
    expect(() =>
      parseAnalysisWorkerRequest({
        type: 'mine',
        requestId: 'mine-1',
        featureKeys: ['input'],
        outlierFraction: 2,
      }),
    ).toThrow()
  })

  it('rejects structurally incomplete outbound responses', () => {
    expect(() =>
      parseAnalysisWorkerResponse({
        type: 'profile',
        requestId: 'load-1',
        profile: { fingerprint: 'profile-v1' },
      }),
    ).toThrow()
  })

  it('accepts a complete profile response', () => {
    expect(
      parseAnalysisWorkerResponse({
        type: 'profile',
        requestId: 'load-1',
        profile: {
          fingerprint: 'profile-v1',
          experimentId: 7,
          rowCount: 0,
          measurementCount: 0,
          calculationDataCount: 0,
          calculationCount: 0,
          columns: [],
          warnings: [],
        },
      }),
    ).toMatchObject({ type: 'profile', requestId: 'load-1' })
  })
})
