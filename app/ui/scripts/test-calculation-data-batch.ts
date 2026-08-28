import assert from 'node:assert/strict'
import { executeCalculationDataBatch } from '../src/features/cae-workbench/calculation/calculationDataBatch'

const targets = [
  { calculation_id: 1, measurement_id: 10 },
  { calculation_id: 2, measurement_id: 10 },
  { calculation_id: 1, measurement_id: 20 },
]

const loads: number[] = []
const executions: string[] = []
const failures: string[] = []
const progress: number[] = []
const summary = await executeCalculationDataBatch({
  targets,
  signal: new AbortController().signal,
  loadMeasurement: async (measurementId) => {
    loads.push(measurementId)
    return `input-${measurementId}`
  },
  execute: async (target, input) => {
    executions.push(`${target.measurement_id}:${target.calculation_id}:${input}`)
    if (target.calculation_id === 2) throw new Error('expected failure')
  },
  onFailure: (target) => failures.push(`${target.measurement_id}:${target.calculation_id}`),
  onProgress: (value) => progress.push(value.completed),
})
assert.deepEqual(loads, [10, 20])
assert.deepEqual(executions, ['10:1:input-10', '10:2:input-10', '20:1:input-20'])
assert.deepEqual(failures, ['10:2'])
assert.deepEqual(summary, { total: 3, completed: 3, succeeded: 2, failed: 1, cancelled: false })
assert.equal(progress.at(-1), 3)

let failedLoads = 0
const failedInput = await executeCalculationDataBatch({
  targets: targets.slice(0, 2),
  signal: new AbortController().signal,
  loadMeasurement: async () => {
    failedLoads += 1
    throw new Error('invalid RecordedData')
  },
  execute: async () => undefined,
})
assert.equal(failedLoads, 1)
assert.deepEqual(failedInput, { total: 2, completed: 2, succeeded: 0, failed: 2, cancelled: false })

const controller = new AbortController()
const cancelled = await executeCalculationDataBatch({
  targets,
  signal: controller.signal,
  loadMeasurement: async (measurementId) => measurementId,
  execute: async () => controller.abort(),
})
assert.deepEqual(cancelled, { total: 3, completed: 1, succeeded: 1, failed: 0, cancelled: true })

console.info('CalculationData batch tests passed.')
