import type { CalculationDataOutput } from '@/api'
import { varsTensorFromFlat } from '@caemble/execution/cad/model/tensor'
import type { Tensor } from '@caemble/execution/cad/model/types'
export { predictedRecordedData } from '@caemble/execution/prediction/recordedData'
export { predictionFingerprint } from '@caemble/execution/prediction/modelDefinition'

export function calculationOutputTensor(output: CalculationDataOutput): Tensor {
  const values = typeof output.data === 'number' ? [output.data] : output.data
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Calculation contains non-finite values.')
  return varsTensorFromFlat(values, output.shape)
}
