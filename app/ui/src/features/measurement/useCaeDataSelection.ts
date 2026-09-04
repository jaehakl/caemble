import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import type { MeasurementRecordedData } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { Vars } from '@/lib/cad/model'
import { recordedDataTreeSnapshot } from './recordedData'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import { measurementDetailQueryOptions, measurementRecordedDataQueryOptions } from './queryOptions'

export function useCaeDataSelection(experimentId: number | null, scope: 'mine' | 'visible' = 'mine') {
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const [measurement, setMeasurement] = useState<SavedMeasurement | null>(null)
  const [recordedDataTree, setRecordedDataTree] = useState<MeasurementRecordedData>({})
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)
  const activeQueryKeys = useRef<QueryKey[]>([])

  const cancelActiveQueries = useCallback(() => {
    const keys = activeQueryKeys.current
    activeQueryKeys.current = []
    keys.forEach((queryKey) => void queryClient.cancelQueries({ queryKey, exact: true }))
  }, [queryClient])

  const clearMeasurement = useCallback(() => {
    requestSequence.current += 1
    cancelActiveQueries()
    setLoading(false)
    setMeasurement(null)
    setRecordedDataTree({})
  }, [cancelActiveQueries])

  useEffect(
    () => () => {
      requestSequence.current += 1
      cancelActiveQueries()
    },
    [cancelActiveQueries, queryScope],
  )

  const loadMeasurement = useCallback(
    async (value: number | SavedMeasurement, expectedExperimentId: number | null = experimentId) => {
      const sequence = ++requestSequence.current
      cancelActiveQueries()
      setLoading(true)
      try {
        let row: SavedMeasurement
        if (typeof value === 'number') {
          const detailOptions = measurementDetailQueryOptions(queryScope, value, scope)
          activeQueryKeys.current = [detailOptions.queryKey]
          row = await queryClient.fetchQuery(detailOptions)
        } else {
          row = value
        }
        if (expectedExperimentId !== null && row.experiment_id !== expectedExperimentId) {
          throw new Error('현재 Experiment에 속한 Measurement가 아닙니다.')
        }
        const recordedDataOptions = measurementRecordedDataQueryOptions(queryScope, row.id)
        activeQueryKeys.current = [recordedDataOptions.queryKey]
        const recorded = await queryClient.fetchQuery(recordedDataOptions)
        if (sequence !== requestSequence.current) return null
        setMeasurement(row)
        setRecordedDataTree(recorded)
        return row
      } catch (error: unknown) {
        if (sequence !== requestSequence.current) return null
        throw error
      } finally {
        if (sequence === requestSequence.current) {
          activeQueryKeys.current = []
          setLoading(false)
        }
      }
    },
    [cancelActiveQueries, experimentId, queryClient, queryScope, scope],
  )

  const snapshot = useMemo(
    () => recordedDataTreeSnapshot(recordedDataTree, measurement?.id ?? 0),
    [measurement?.id, recordedDataTree],
  )

  return useMemo(
    () => ({
      measurement,
      recordedRows: snapshot.rows,
      recordedData: snapshot.data,
      flatRecordedData: snapshot.flatData,
      recordedRules: snapshot.rules,
      recordedSchemas: snapshot.schemas,
      variables: measurement?.vars as Readonly<Vars> | undefined,
      materialSnapshot: measurement?.material_parameters ?? null,
      loading,
      clearAll: clearMeasurement,
      clearMeasurement,
      loadMeasurement,
    }),
    [clearMeasurement, loadMeasurement, loading, measurement, snapshot],
  )
}

export type CaeDataSelection = ReturnType<typeof useCaeDataSelection>
