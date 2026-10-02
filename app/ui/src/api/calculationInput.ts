import { createDbTables } from './api'
import type { CaembleClient } from './http'
import { prepareRecordedCalculationInput } from '@caemble/execution/calculation/recordedInput'

export async function fetchCalculationInput(
  client: CaembleClient,
  measurementId: number,
  source: string,
  signal?: AbortSignal,
) {
  const tree = await createDbTables(client).Measurement.readRecordedData(measurementId, { signal })
  return prepareRecordedCalculationInput(tree, source)
}
