import { CALCULATION_INDEX_POLICY_MESSAGE } from './runtimeGlobals'
import { CalculationExecutionError, type CalculationSourceDiagnostic } from './types'

export function calculationIndex(index: unknown, diagnostic: CalculationSourceDiagnostic) {
  if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) return index
  throw new CalculationExecutionError('policy', CALCULATION_INDEX_POLICY_MESSAGE, {
    ...diagnostic,
    message: CALCULATION_INDEX_POLICY_MESSAGE,
  })
}
