import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import type { MeasurementRecordedData } from '../contracts/api/measurement'
import { installCatalogRuntimeSlice } from '../catalog/runtime'
import { prepareCompiledPrediction } from '../cad/execution/userModule'
import { recordedDataRules } from '../cad/simulation/recordedData'
import { prepareRecordedCalculationInput } from '../calculation/recordedInput'
import { preparePredictedCalculationInput, type PredictedCalculationArtifact } from '../calculation/predictedInput'
import { prepareCaeMeasurement, type CaePreparationRequest } from './build'
import { compileNodeCadDocument } from './cadCompiler'
import { runNodeCalculation } from './calculation'

type EvaluationCalculation = Readonly<{ key: string; source: string; source_hash: string }>

export type EvaluationRequest =
  | Readonly<{ stage: 'build'; build: CaePreparationRequest }>
  | Readonly<{ stage: 'predict_prepare'; build: CaePreparationRequest; record_names: readonly string[] }>
  | Readonly<{
      stage: 'calculate_prediction'
      prediction: PredictedCalculationArtifact
      calculations: readonly EvaluationCalculation[]
    }>
  | Readonly<{
      stage: 'calculate'
      measurement_id: number
      recorded_data: MeasurementRecordedData
      calculations: readonly EvaluationCalculation[]
    }>

export async function evaluateRequest(request: EvaluationRequest, declarationsDirectory: string) {
  if (request.stage === 'build') {
    if (request.build.mode !== 'candidate') throw new Error('Evaluation build requires Candidate Vars.')
    const result = await prepareCaeMeasurement(request.build, declarationsDirectory)
    return { measurement: result.measurement, presentation: result.presentation }
  }
  if (request.stage === 'predict_prepare') {
    const { build, record_names } = request
    if (build.mode !== 'candidate' || !build.vars) throw new Error('Prediction requires Candidate Vars.')
    if (!record_names.length || new Set(record_names).size !== record_names.length)
      throw new Error('Prediction requires unique Record names.')
    installCatalogRuntimeSlice(build.catalog)
    const compiled = compileNodeCadDocument(
      build.source_bundle.files,
      build.source_hash,
      build.catalog,
      declarationsDirectory,
    )
    const timeout = build.evaluation_timeout_ms ?? 3000
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000)
      throw new Error('Invalid evaluation timeout.')
    const candidate: ReturnType<typeof prepareCompiledPrediction> = runInNewContext(
      'prepare()',
      {
        prepare: () =>
          prepareCompiledPrediction(compiled, build.vars!, build.source_bundle.files['simulate.py'], record_names),
      },
      { timeout },
    )
    const rules = recordedDataRules(candidate.simulationProgram.recordedData, 'prediction').filter((rule) =>
      record_names.includes(rule.label),
    )
    return { vars: candidate.variables, rules, candidate_box_grids: candidate.simulationProgram.boxGrids }
  }
  if (request.stage !== 'calculate' && request.stage !== 'calculate_prediction')
    throw new Error('Unknown evaluation stage.')
  const calculations = []
  for (const calculation of request.calculations) {
    if (createHash('sha256').update(calculation.source, 'utf8').digest('hex') !== calculation.source_hash)
      throw new Error(`Calculation ${calculation.key} source hash does not match its frozen definition.`)
    const { input } =
      request.stage === 'calculate'
        ? prepareRecordedCalculationInput(request.recorded_data, calculation.source)
        : preparePredictedCalculationInput(request.prediction, calculation.source)
    const result = await runNodeCalculation(calculation.source, input)
    if (
      result.output.shape.length !== 0 ||
      typeof result.output.data !== 'number' ||
      !Number.isFinite(result.output.data)
    )
      throw new Error(`Calculation ${calculation.key} must return one finite scalar.`)
    calculations.push({
      key: calculation.key,
      source_hash: result.sourceHash,
      value: result.output.data,
      output: result.output,
      logs: result.logs,
    })
  }
  return { ...(request.stage === 'calculate' ? { measurement_id: request.measurement_id } : {}), calculations }
}
