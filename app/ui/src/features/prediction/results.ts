import type { CalculationDataOutput } from '@/api'
import type { PredictionValidationMetric } from './metrics'
import type { PredictionCalculations } from './usePredictionModels'

export type ValidationRow = Readonly<{
  calculationId: number
  reference: CalculationDataOutput
  actual: CalculationDataOutput | null
  metric: PredictionValidationMetric | null
  error: string | null
}>
export type PredictionResults = Readonly<{
  calculations: PredictionCalculations | null
  actual: readonly ValidationRow[]
  measurementId: number | null
}>
export const initialPredictionResults: PredictionResults = Object.freeze({
  calculations: null,
  actual: [],
  measurementId: null,
})
export type PredictionResultsAction =
  | Readonly<{ type: 'calculated'; calculations: PredictionCalculations }>
  | Readonly<{ type: 'validated'; rows: readonly ValidationRow[]; measurementId: number }>
  | Readonly<{ type: 'cleared' }>
export function predictionResultsReducer(state: PredictionResults, action: PredictionResultsAction): PredictionResults {
  if (action.type === 'cleared') return initialPredictionResults
  if (action.type === 'calculated')
    return { ...state, calculations: action.calculations, actual: [], measurementId: null }
  return { ...state, actual: action.rows, measurementId: action.measurementId }
}
