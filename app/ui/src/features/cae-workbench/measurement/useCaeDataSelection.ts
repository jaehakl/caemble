import { useCallback, useMemo, useRef, useState } from 'react'
import { dbTables, getListRequest } from '@/api'
import type { Vars } from '@/lib/cad'
import { recordedDataSnapshot } from './recordedData'
import type { SavedMeasurement, SavedRecordedData } from '../types'

async function fetchMeasurement(id: number, scope: 'mine' | 'visible') {
  const row = (await dbTables.Measurement.listRows(getListRequest(scope, [id]))).items[0]
  if (!row?.id) throw new Error(`Measurement #${id}을 찾을 수 없습니다.`)
  return row as SavedMeasurement
}

export function useCaeDataSelection(experimentId: number | null, scope: 'mine' | 'visible' = 'mine') {
  const [measurement, setMeasurement] = useState<SavedMeasurement | null>(null)
  const [recordedRows, setRecordedRows] = useState<readonly SavedRecordedData[]>([])
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)

  const clearMeasurement = useCallback(() => {
    requestSequence.current += 1
    setLoading(false)
    setMeasurement(null)
    setRecordedRows([])
  }, [])

  const loadMeasurement = useCallback(
    async (value: number | SavedMeasurement, expectedExperimentId: number | null = experimentId) => {
      const sequence = ++requestSequence.current
      setLoading(true)
      try {
        const row = typeof value === 'number' ? await fetchMeasurement(value, scope) : value
        if (expectedExperimentId !== null && row.experiment_id !== expectedExperimentId) {
          throw new Error('현재 Experiment에 속한 Measurement가 아닙니다.')
        }
        const recorded = await dbTables.RecordedData.listRows({
          ...getListRequest(scope),
          limit: null,
          filter: { measurement_id: [row.id, row.id] },
        })
        if (sequence !== requestSequence.current) return null
        setMeasurement(row)
        setRecordedRows(recorded.items as SavedRecordedData[])
        return row
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [experimentId, scope],
  )

  const snapshot = useMemo(() => recordedDataSnapshot(recordedRows), [recordedRows])

  return {
    measurement,
    recordedRows,
    recordedData: snapshot.data,
    recordedRules: snapshot.rules,
    variables: measurement?.vars as Readonly<Vars> | undefined,
    materialSnapshot: measurement?.material_parameters ?? null,
    loading,
    clearAll: clearMeasurement,
    clearMeasurement,
    loadMeasurement,
  }
}

export type CaeDataSelection = ReturnType<typeof useCaeDataSelection>
