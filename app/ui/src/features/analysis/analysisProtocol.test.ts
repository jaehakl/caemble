import { describe, expect, it } from 'vitest'
import { parseAnalysisWorkerRequest, parseAnalysisWorkerResponse } from './analysisProtocol'

describe('Analysis Worker protocol', () => {
  it.each(['mine', 'table-page', 'export-csv'])('rejects the removed %s request', (type) => {
    expect(() =>
      parseAnalysisWorkerRequest({
        type,
        requestId: 'retired',
        featureKeys: ['input'],
        outlierFraction: 0.05,
        columnKeys: ['input'],
        offset: 0,
        limit: 100,
      }),
    ).toThrow()
  })
  it.each(['mining', 'table-page', 'csv'])('rejects the removed %s response', (type) => {
    expect(() =>
      parseAnalysisWorkerResponse({ type, requestId: 'retired', blob: new Blob(), filename: 'data.csv' }),
    ).toThrow()
  })
  it('rejects malformed inbound requests before running analysis', () => {
    expect(() =>
      parseAnalysisWorkerRequest({
        type: 'load-context',
        requestId: 'load-1',
        experimentId: -1,
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
