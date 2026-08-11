import type { RecordedData, RecordedDataResult, RecordedDataRule } from '@/lib/cad'
import type { SavedRecordedData } from '../types'

export function recordedDataSnapshot(rows: readonly SavedRecordedData[]) {
  const usableRows = rows.filter((row) => row.data !== null && row.data !== undefined)
  const data = Object.freeze(Object.fromEntries(usableRows.map((row) => [row.name, row.data]))) as RecordedData
  const rules = Object.freeze(
    usableRows.map((row) => {
      const schema = row.data_schema ?? { dtype: row.dtype }
      return Object.freeze({
        target: Object.freeze([]),
        label: row.name,
        methodId: 'measurement.recorded-data',
        parameters: Object.freeze({}),
        result: Object.freeze({
          ...schema,
          dtype: row.dtype,
          tensorOrder: row.tensor_order,
          ...(row.quantity_kind ? { quantityKind: row.quantity_kind } : {}),
        }) as RecordedDataResult,
      }) satisfies RecordedDataRule
    }),
  )
  return { data, rules }
}
