import type { BoxGridData } from '../contracts/boxGrid'
import type { RecordedDataRule } from '../cad/model/descriptor'
import { predictedRecordedData } from '../prediction/recordedData'
import type { PredictionTensorSample } from '../prediction/types'
import { analyzeCalculationDependencies } from './dependencies'
import { createCalculationInput } from './input'

/** Persisted independently of a Measurement so Calculation can retry without inference. */
export type PredictedCalculationArtifact = Readonly<{
  output: readonly PredictionTensorSample[]
  rules: readonly RecordedDataRule[]
  candidate_box_grids: Readonly<Record<string, BoxGridData>>
}>

export function preparePredictedCalculationInput(artifact: PredictedCalculationArtifact, source: string) {
  const dependencies = analyzeCalculationDependencies(
    source,
    artifact.rules.map((rule) => rule.label),
  )
  const rules = artifact.rules
    .filter((rule) => dependencies.includes(rule.label))
    .map((rule) => {
      const grid = artifact.candidate_box_grids[rule.label]
      if (!grid) throw new Error(`${rule.label}: Candidate BoxGrid is missing.`)
      return {
        ...rule,
        result: {
          ...rule.result,
          axes: rule.result.axes?.map((axis, index) =>
            index < 3
              ? { ...axis, ticks: undefined, unit: grid.lengthUnit, quantityKind: axis.quantityKind ?? 'Length' }
              : axis,
          ),
        },
      }
    })
  const samples = artifact.output.filter((sample) => dependencies.includes(sample.layout.key))
  const recorded = predictedRecordedData(samples, rules, undefined, artifact.candidate_box_grids)
  return { input: createCalculationInput(rules, recorded), dependencies }
}
