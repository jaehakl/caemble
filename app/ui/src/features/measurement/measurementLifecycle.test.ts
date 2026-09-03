import { describe, expect, it } from 'vitest'
import {
  initialMeasurementLifecycleState,
  measurementLifecycleReducer,
  selectMeasurementLifecycle,
  type GenerateAndRunState,
} from './measurementLifecycle'

const generateAndRunState: GenerateAndRunState = Object.freeze({
  attempt: 1,
  baselineRevision: 3,
  candidateGeneration: 4,
  experimentId: 5,
  failures: 0,
  measurementId: null,
  phase: 'candidate',
  repeat: true,
  sequence: 6,
  sourceHash: 'source-hash',
  successes: 0,
  total: 2,
})

describe('measurementLifecycleReducer', () => {
  it('moves a successful run through preparation, execution, recording, and calculation', () => {
    const preparing = measurementLifecycleReducer(initialMeasurementLifecycleState, {
      type: 'start',
      operation: 'measurement',
      status: 'preparing',
      stage: 'Measurement 평가',
    })
    const running = measurementLifecycleReducer(preparing, {
      type: 'progress',
      status: 'running',
      stage: 'Simulation 실행',
    })
    const recording = measurementLifecycleReducer(running, {
      type: 'progress',
      status: 'recording',
      stage: 'RecordedData 저장',
    })
    const calculating = measurementLifecycleReducer(recording, {
      type: 'calculationStarted',
      stage: 'CalculationData 계산',
    })
    const calculationFinished = measurementLifecycleReducer(calculating, { type: 'calculationFinished' })
    const succeeded = measurementLifecycleReducer(calculationFinished, { type: 'complete' })

    expect(preparing.status).toBe('preparing')
    expect(running.status).toBe('running')
    expect(recording.status).toBe('recording')
    expect(calculating).toMatchObject({ status: 'calculating', automaticCalculationData: true })
    expect(calculationFinished).toMatchObject({ status: 'recording', automaticCalculationData: false })
    expect(succeeded.status).toBe('succeeded')
    expect(selectMeasurementLifecycle(succeeded)).toMatchObject({
      busy: false,
      operation: null,
      stage: null,
      error: null,
    })
  })

  it('keeps a failed RecordedData save available for retry after the operation finishes', () => {
    const running = measurementLifecycleReducer(initialMeasurementLifecycleState, {
      type: 'start',
      operation: 'measurement',
      status: 'running',
      stage: 'Simulation 실행',
    })
    const pending = measurementLifecycleReducer(running, { type: 'recordPending', measurementId: 17 })
    const failed = measurementLifecycleReducer(pending, { type: 'fail', message: 'RecordedData 저장 실패' })
    const completed = measurementLifecycleReducer(failed, { type: 'complete' })

    expect(completed).toMatchObject({
      status: 'failed',
      operation: null,
      error: 'RecordedData 저장 실패',
      pendingRecordMeasurementId: 17,
    })
  })

  it('clears the pending retry and prior error only after retry succeeds', () => {
    const pendingFailure = measurementLifecycleReducer(
      measurementLifecycleReducer(initialMeasurementLifecycleState, {
        type: 'recordPending',
        measurementId: 21,
      }),
      { type: 'fail', message: 'network error' },
    )
    const retrying = measurementLifecycleReducer(pendingFailure, {
      type: 'start',
      operation: 'record',
      status: 'recording',
      stage: 'RecordedData 다시 저장',
    })
    const retried = measurementLifecycleReducer(retrying, { type: 'retrySucceeded' })
    const completed = measurementLifecycleReducer(retried, { type: 'complete' })

    expect(retrying).toMatchObject({ pendingRecordMeasurementId: 21, error: null })
    expect(retried).toMatchObject({ pendingRecordMeasurementId: null, error: null })
    expect(completed.status).toBe('succeeded')
  })

  it('marks cancellation without moving controller resources into reducer state and resets to idle', () => {
    const running = measurementLifecycleReducer(initialMeasurementLifecycleState, {
      type: 'start',
      operation: 'save-and-run',
      status: 'running',
      stage: 'Simulation 실행',
    })
    const calculating = measurementLifecycleReducer(running, { type: 'calculationStarted' })
    const cancelling = measurementLifecycleReducer(calculating, { type: 'cancel' })
    const completed = measurementLifecycleReducer(cancelling, { type: 'complete' })
    const calculationSettled = measurementLifecycleReducer(completed, { type: 'calculationFinished' })
    const reset = measurementLifecycleReducer(calculationSettled, { type: 'reset' })

    expect(cancelling).toMatchObject({
      status: 'cancelling',
      operation: 'save-and-run',
      stage: 'Simulation 실행',
    })
    expect(completed).toMatchObject({ status: 'succeeded', operation: null, automaticCalculationData: true })
    expect(calculationSettled.automaticCalculationData).toBe(false)
    expect(reset).toBe(initialMeasurementLifecycleState)
  })

  it('updates repeat-run metadata and visible progress in one transition', () => {
    const started = measurementLifecycleReducer(initialMeasurementLifecycleState, {
      type: 'start',
      operation: 'generate-and-run',
      status: 'preparing',
      stage: '1/2 · Candidate 생성',
      generateAndRunState,
    })
    const runningState: GenerateAndRunState = {
      ...generateAndRunState,
      measurementId: 30,
      phase: 'running',
    }
    const running = measurementLifecycleReducer(started, {
      type: 'progress',
      status: 'running',
      stage: '1/2 · Simulation 실행',
      generateAndRunState: runningState,
    })

    expect(running).toMatchObject({
      status: 'running',
      stage: '1/2 · Simulation 실행',
      generateAndRunState: runningState,
    })
  })
})
