import type { CalculationDataOutput } from '@/api'
import { varsTensorFromFlat } from '@caemble/execution/cad/model/tensor'
import type { Tensor } from '@caemble/execution/cad/model/types'
export { predictedRecordedData } from '@caemble/execution/prediction/recordedData'

export function calculationOutputTensor(output: CalculationDataOutput): Tensor {
  const values = typeof output.data === 'number' ? [output.data] : output.data
  if (values.some((value) => !Number.isFinite(value))) throw new Error('Calculation contains non-finite values.')
  return varsTensorFromFlat(values, output.shape)
}

export function predictionFingerprint(parts: readonly unknown[]) {
  return JSON.stringify(parts, (_key, value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
    const record = value as Readonly<Record<string, unknown>>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
}
