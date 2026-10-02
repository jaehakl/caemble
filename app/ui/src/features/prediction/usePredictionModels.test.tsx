import { beforeEach, expect, it, vi } from 'vitest'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import { PredictionRuntimeController } from './predictionRuntime'
import { calculatePrediction, predictCandidate, predictionSetupFingerprint } from './usePredictionModels'
import { calculation, context, grid, model, remoteFixture, rule, setup, varsSchema } from './forward.fixture'

const calculate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/calculation', async (original) => ({
  ...(await original<typeof import('@/lib/calculation')>()),
  runCalculation: calculate,
}))
beforeEach(() => calculate.mockReset())

async function predict() {
  const remote = remoteFixture()
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const candidateGrid = { ...grid, origin: [5, 6, 7] as const, size: [2, 4, 6] as const }
  const preview = await predictCandidate({
    runtime,
    transaction: runtime.beginTransaction(),
    setup,
    context,
    varsSchema,
    vars: { x: 0.5 },
    sourceHash: 'source',
    candidateBoxGrids: { 'heat.T': candidateGrid },
    resultContracts: {},
  })
  return { preview, runtime, remote, candidateGrid }
}

it('predicts native BoxGrid without Calculation and attaches Candidate and immutable model provenance', async () => {
  const { preview, runtime, remote, candidateGrid } = await predict()
  expect(preview.recorded['heat.T'].boxGrid).toEqual(candidateGrid)
  const tensor = preview.recorded['heat.T']
  if (!isDataTensor(tensor)) throw new Error('Expected a native prediction tensor')
  expect(createDataTensorAccessor(rule.result, tensor).at(0)).toBe(15)
  expect(preview.source).toMatchObject({
    kind: 'prediction',
    candidate: { vars: { x: 0.5 }, sourceHash: 'source' },
    model: model.provenance,
  })
  expect(remote).not.toHaveProperty('prepare')
  expect(calculate).not.toHaveBeenCalled()
  runtime.dispose()
})

it('runs optional Calculation separately and preserves prediction through postprocessing failure', async () => {
  const { preview, runtime, remote } = await predict()
  const withCalculation = { ...context, calculations: [calculation] }
  calculate.mockRejectedValueOnce(new Error('analysis failure'))
  const failed = await calculatePrediction(preview, [calculation], withCalculation, new AbortController().signal)
  expect(failed.errors).toEqual({ 2: 'analysis failure' })
  expect(failed.source).toBe(preview.source)
  expect(preview.recorded['heat.T']).toBeDefined()
  calculate.mockResolvedValueOnce({ dtype: 'float64', shape: [], axes: [], data: 15 })
  const completed = await calculatePrediction(preview, [calculation], withCalculation, new AbortController().signal)
  expect(completed.values[2].data).toBe(15)
  expect(completed.source).toBe(preview.source)
  expect(remote.predict).toHaveBeenCalledOnce()
  expect(remote.load).toHaveBeenCalledOnce()
  expect(predictionSetupFingerprint({ ...setup, calculationIds: [2] })).toBe(predictionSetupFingerprint(setup))
  runtime.dispose()
})

it('requires missing analysis outputs without changing the model or running inference', async () => {
  const { preview, runtime, remote } = await predict()
  const result = await calculatePrediction(
    preview,
    [{ ...calculation, experiment_record_ids: [8] }],
    {
      ...context,
      experimentRecords: [...context.experimentRecords, { ...context.experimentRecords[0], id: 8, name: 'heat.other' }],
    },
    new AbortController().signal,
  )
  expect(result.errors[2]).toContain('heat.other BoxGrid')
  expect(calculate).not.toHaveBeenCalled()
  expect(remote.predict).toHaveBeenCalledOnce()
  runtime.dispose()
})

it('adapts legacy spatial ticks and units to Candidate geometry without rewriting stored rules', async () => {
  const remote = remoteFixture()
  const legacyRule = {
    ...rule,
    result: {
      ...rule.result,
      axes: rule.result.axes!.map((axis, index) => (index < 3 ? { ...axis, ticks: [0.5] } : axis)),
    },
  }
  remote.load.mockResolvedValue({ ...model, rules: [legacyRule] })
  const runtime = new PredictionRuntimeController(() => remote)
  runtime.start()
  const preview = await predictCandidate({
    runtime,
    transaction: runtime.beginTransaction(),
    setup,
    context,
    varsSchema,
    vars: { x: 0.5 },
    sourceHash: 'source',
    candidateBoxGrids: { 'heat.T': { ...grid, size: [1000, 2000, 3000], lengthUnit: 'mm' } },
    resultContracts: {},
  })
  calculate.mockResolvedValue({ dtype: 'float64', shape: [], axes: [], data: 15 })
  const completed = await calculatePrediction(preview, [calculation], context, new AbortController().signal)
  expect(completed.errors).toEqual({})
  expect(calculate.mock.calls[0][0].input['heat.T'].axes[0]).toMatchObject({ unit: 'mm', ticks: [500] })
  expect(legacyRule.result.axes![0]).toMatchObject({ ticks: [0.5], unit: 'm' })
  expect(preview.source.recordIds).toEqual([7])
  expect(Object.isFrozen(preview.source.candidate.vars)).toBe(true)
  runtime.dispose()
})
