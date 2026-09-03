import { describe, expect, it } from 'vitest'
import {
  initialPredictionLifecycleState,
  predictionLifecycleReducer,
  type PredictionSamplingProgress,
} from './lifecycle'

const samplingProgress: PredictionSamplingProgress = Object.freeze({
  attempt: 2,
  failures: 1,
  phase: 'simulation',
  recorded: 1,
  sessionId: 'sampling-session',
  successes: 1,
  total: 5,
})

describe('prediction lifecycle transitions', () => {
  it('tracks data loading as a bounded busy operation', () => {
    const loading = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'operation-started',
      operation: 'loading',
      status: 'loading data',
    })
    expect(loading).toMatchObject({ busy: true, operation: 'loading', status: 'loading data' })
    expect(predictionLifecycleReducer(loading, { type: 'operation-finished', status: 'data ready' })).toMatchObject({
      busy: false,
      operation: 'idle',
      status: 'data ready',
    })
  })

  it('starts and finishes forward and inverse work with an explicit direction', () => {
    const forward = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'operation-started',
      operation: 'forward',
      direction: 'forward',
      status: 'forward running',
    })
    expect(forward).toMatchObject({ busy: true, direction: 'forward', operation: 'forward' })

    const inverse = predictionLifecycleReducer(forward, {
      type: 'operation-started',
      operation: 'inverse',
      direction: 'inverse',
      status: 'inverse running',
    })
    expect(inverse).toMatchObject({ busy: true, direction: 'inverse', operation: 'inverse' })

    expect(predictionLifecycleReducer(inverse, { type: 'operation-finished' })).toMatchObject({
      busy: false,
      direction: 'inverse',
      operation: 'idle',
    })
  })

  it('distinguishes validation from a Calculation retry', () => {
    const validating = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'operation-started',
      operation: 'validation',
      status: 'validating',
    })
    expect(validating).toMatchObject({ busy: true, retryingValidation: false, validating: true })

    const retrying = predictionLifecycleReducer(validating, {
      type: 'operation-started',
      operation: 'validation-retry',
      status: 'retrying',
    })
    expect(retrying).toMatchObject({ busy: true, retryingValidation: true, validating: true })

    expect(predictionLifecycleReducer(retrying, { type: 'operation-finished' })).toMatchObject({
      busy: false,
      retryingValidation: false,
      validating: false,
    })
  })

  it('keeps sampling progress visible until sampling cleanup finishes', () => {
    const sampling = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'operation-started',
      operation: 'sampling',
      samplingProgress,
      status: 'sampling',
    })
    expect(sampling.samplingProgress).toBe(samplingProgress)

    const stopping = predictionLifecycleReducer(sampling, {
      type: 'sampling-progressed',
      progress: { ...samplingProgress, phase: 'stopping' },
    })
    expect(stopping.samplingProgress?.phase).toBe('stopping')
    expect(predictionLifecycleReducer(stopping, { type: 'operation-finished', clearSampling: true })).toMatchObject({
      busy: false,
      operation: 'idle',
      samplingProgress: null,
    })
  })

  it('cancellation atomically clears active work while preserving freshness decisions', () => {
    const sampling = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'operation-started',
      operation: 'sampling',
      samplingProgress,
      status: 'sampling',
    })
    const cancelled = predictionLifecycleReducer(sampling, {
      type: 'cancelled',
      dataStale: true,
      freshnessPending: true,
    })

    expect(cancelled).toEqual({
      ...initialPredictionLifecycleState,
      dataStale: true,
      freshnessPending: true,
      status: 'Prediction 작업을 취소했습니다.',
    })
  })

  it('tracks freshness and stale data independently of the active operation', () => {
    const checked = predictionLifecycleReducer(initialPredictionLifecycleState, {
      type: 'freshness-pending-changed',
      pending: false,
    })
    const stale = predictionLifecycleReducer(checked, { type: 'data-stale-changed', stale: true })
    expect(stale).toMatchObject({ dataStale: true, freshnessPending: false, operation: 'idle' })
  })
})
