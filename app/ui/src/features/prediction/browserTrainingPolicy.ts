import type { RecordedDataRecord } from '@/api'
import { isDataTensor } from '@/lib/cad/model/dataTensor'
import { predictionVarsLayouts } from './data'
import type { PredictionTrainingPolicy } from './execution'
import { PREDICTION_NUMERIC_CELL_LIMIT, type PredictionTrainingRow } from './knn'

export function assertTrainingCellLimit(rows: readonly PredictionTrainingRow[]) {
  let cells = 0
  rows.forEach((row) => {
    row.inputs.forEach((sample) => (cells += sample.values.length))
    row.outputs.forEach((sample) => (cells += sample.values.length))
  })
  if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
    throw new Error(
      `Prediction training data contains ${cells.toLocaleString()} numeric cells; the limit is ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}.`,
    )
  }
}

/** Browser policy: inspect metadata before object downloads or tensor expansion. */
export function assertPredictionRecordedMemory(rows: readonly RecordedDataRecord[], inputSize: number) {
  let cells = 0
  for (const row of rows) {
    if (!isDataTensor(row.data)) continue
    const shape = row.data.shape
    const values = shape.reduce((size, length) => size * length, 1)
    cells += values + inputSize + (row.data.boxGrid?.frequencyKind === 'modal' ? (shape[4] ?? 0) : 0)
    if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
      throw new Error(
        `Box Grid Prediction 학습 데이터가 ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}개 수치 값 제한을 초과합니다. Grid 또는 학습 Measurement 수를 줄이세요.`,
      )
    }
  }
}

export const browserPredictionTrainingPolicy: PredictionTrainingPolicy = Object.freeze({
  checkRecordedData(rows, schema) {
    assertPredictionRecordedMemory(
      rows,
      predictionVarsLayouts(schema).reduce(
        (size, layout) => size + layout.shape.reduce((count, length) => count * length, 1),
        0,
      ),
    )
  },
  checkCalculationData(rows) {
    let cells = 0
    for (const row of rows) {
      cells += row.data.shape.length === 0 ? 1 : (row.data.data as readonly number[]).length
      if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
        throw new Error(
          `Prediction CalculationData contains more than ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()} numeric cells.`,
        )
      }
    }
  },
})
