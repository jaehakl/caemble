import type { MeasurementRecordedData } from '@/contracts/api/measurement'
import { prepareRecordedCalculationInput } from '@/lib/calculation/recordedInput'
import { prepareCaeMeasurement, type CaePreparationRequest } from './build'
import { runNodeCalculation } from './calculation'

export type EvaluationRequest =
  | Readonly<{ stage: 'build'; build: CaePreparationRequest }>
  | Readonly<{
      stage: 'calculate'
      measurement_id: number
      recorded_data: MeasurementRecordedData
      calculations: readonly Readonly<{ key: string; source: string; source_hash: string }>[]
    }>

export async function evaluateRequest(request: EvaluationRequest, declarationsDirectory: string) {
  if (request.stage === 'build') {
    if (request.build.mode !== 'candidate') throw new Error('Evaluation build requires Candidate Vars.')
    const result = await prepareCaeMeasurement(request.build, declarationsDirectory)
    return { measurement: result.measurement, presentation: result.presentation }
  }
  if (request.stage !== 'calculate') throw new Error('Unknown evaluation stage.')
  const calculations = []
  for (const calculation of request.calculations) {
    const { input } = prepareRecordedCalculationInput(request.recorded_data, calculation.source)
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
  return { measurement_id: request.measurement_id, calculations }
}
