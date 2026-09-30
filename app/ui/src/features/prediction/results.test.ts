import { expect, it } from 'vitest'
import type { PredictionExecutionResult } from './execution'
import { initialPredictionResults, predictionResultsReducer } from './results'

it('accepts predictions without kNN details and clears neighbors from the previous result', () => {
  const result: PredictionExecutionResult = {
    direction: 'forward',
    fingerprint: 'definition',
    output: [{ layout: { key: 'signal', dtype: 'float64', shape: [] }, values: [3] }],
    constantInputKeysChanged: [],
    extrapolatedInputKeys: [],
    queryDiagnostics: [],
  }
  const previous = {
    ...initialPredictionResults,
    neighborsByDirection: { forward: [{ measurementId: 1, distanceSquared: 0, weight: 1 }] },
  }
  const completed = predictionResultsReducer(previous, {
    type: 'forward-completed',
    result,
    errors: {},
    fingerprint: 'candidate',
  })
  expect(completed.lastResult).toBe(result)
  expect(completed.neighborsByDirection.forward).toEqual([])
  expect(completed.forwardVarsFingerprint).toBe('candidate')
})
