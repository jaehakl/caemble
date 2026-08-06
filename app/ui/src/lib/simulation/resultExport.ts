import { createDataTensorAccessor } from '../cad/model/dataTensor'
import type { SimulationResult } from './types'

export function exportSimulationResult(result: SimulationResult) {
  const recordedData = Object.freeze(
    Object.fromEntries(
      Object.entries(result.recordedData).map(([name, entry]) => {
        const accessor = createDataTensorAccessor(
          entry.spec,
          entry.data,
          `Simulation RecordedData ${JSON.stringify(name)}.data`,
        )
        return [
          name,
          Object.freeze({
            ...entry,
            data: Object.freeze({
              value: accessor.materialize(),
              ...(accessor.tensor.axes === undefined ? {} : { axes: accessor.tensor.axes }),
            }),
          }),
        ]
      }),
    ),
  )
  return JSON.stringify({ ...result, recordedData }, null, 2)
}
