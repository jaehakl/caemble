import { expect, it } from 'vitest'
import type { PredictionExecutionResult, PredictionProvenance } from './execution'
import { initialPredictionResults, predictionResultsReducer, type ValidationResult } from './results'

const inverseProvenance: PredictionProvenance = {
  modelId: 'inverse-model',
  modelRevision: 2,
  datasetId: 'inverse-data',
  datasetRevision: 3,
}
const forwardProvenance: PredictionProvenance = {
  modelId: 'forward-model',
  modelRevision: 5,
  datasetId: 'forward-data',
  datasetRevision: 1,
}
const inverseResult: PredictionExecutionResult = {
  direction: 'inverse',
  fingerprint: 'inverse-definition',
  provenance: inverseProvenance,
  output: [{ layout: { key: 'width', dtype: 'float64', shape: [] }, values: [3] }],
  constantInputKeysChanged: [],
  extrapolatedInputKeys: [],
  queryDiagnostics: [],
}

it('retains separate Inverse and re-predicted Forward provenance through validation and candidate edits', () => {
  const inverse = predictionResultsReducer(initialPredictionResults, {
    type: 'inverse-completed',
    result: inverseResult,
    fingerprint: 'candidate',
  })
  const repredicted = predictionResultsReducer(inverse, {
    type: 'surrogate-completed',
    values: { 7: { dtype: 'float64', shape: [], axes: [], data: 8 } },
    errors: {},
    provenance: forwardProvenance,
  })
  expect(repredicted.lastResult?.direction).toBe('inverse')
  expect(repredicted.provenanceByDirection).toEqual({ inverse: inverseProvenance, forward: forwardProvenance })
  const validation: ValidationResult = {
    aggregateError: 0,
    calculationContractFingerprint: 'contract',
    candidateVarsFingerprint: 'candidate',
    calculationWeights: { 7: 1 },
    direction: 'inverse',
    experimentId: 3,
    inverseInputLayouts: [],
    inverseInputScales: null,
    measurementId: 10,
    primaryRevision: 1,
    repredicted: repredicted.surrogateValues,
    rows: [],
    snapshotFingerprint: 'snapshot',
    sourceFingerprints: { 7: 'source' },
    setupFingerprint: 'setup',
    sourceIdentity: 'experiment-source',
    summary: 'verified',
    transactionId: 4,
    modelProvenance: { ...repredicted.provenanceByDirection },
  }
  const validated = predictionResultsReducer(repredicted, { type: 'validation-completed', validation })
  const changedForward = { ...forwardProvenance, modelRevision: 6 }
  const refreshed = predictionResultsReducer(validated, {
    type: 'surrogate-completed',
    values: {},
    errors: {},
    provenance: changedForward,
  })
  expect(refreshed.provenanceByDirection).toEqual({ inverse: inverseProvenance, forward: changedForward })
  expect(refreshed.validation?.modelProvenance).toEqual({ inverse: inverseProvenance, forward: forwardProvenance })
  const edited = predictionResultsReducer(refreshed, { type: 'candidate-edited', direction: 'inverse' })
  expect(edited.validation).toBeNull()
  expect(edited.inverseVarsFingerprint).toBeNull()
  expect(edited.provenanceByDirection).toEqual(refreshed.provenanceByDirection)
  const reloaded = predictionResultsReducer(edited, { type: 'context-reloaded', validation })
  expect(reloaded.validation?.modelProvenance).toEqual({ inverse: inverseProvenance, forward: forwardProvenance })
})

it('removes stale remote Forward attribution when re-prediction uses an unsaved browser model', () => {
  const remote = {
    ...initialPredictionResults,
    provenanceByDirection: { inverse: inverseProvenance, forward: forwardProvenance },
  }
  const browser = predictionResultsReducer(remote, { type: 'surrogate-completed', values: {}, errors: {} })
  expect(browser.provenanceByDirection.inverse).toEqual(inverseProvenance)
  expect(browser.provenanceByDirection.forward).toBeUndefined()
  expect(predictionResultsReducer(browser, { type: 'access-lost' }).provenanceByDirection).toEqual({})
})

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
