import type { RecordedResultContracts } from '@/contracts/results'
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
  const [resultContracts, setResultContracts] = useState<RecordedResultContracts | null>(null)
  const [resultErrors, setResultErrors] = useState<Readonly<Record<string, string>>>({})
  const [loading, setLoading] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<Readonly<{ completed: number; total: number }> | null>(null)
  const requestSequence = useRef(0)
  const requestedMeasurementId = useRef<number | null>(null)
  const activeQueryKeys = useRef<QueryKey[]>([])

  const cancelActiveQueries = useCallback(() => {
    const keys = activeQueryKeys.current
    activeQueryKeys.current = []
    keys.forEach((queryKey) => void queryClient.cancelQueries({ queryKey, exact: true }))
  }, [queryClient])

  const clearMeasurement = useCallback(() => {
    requestedMeasurementId.current = null
    requestSequence.current += 1
    cancelActiveQueries()
    setLoading(false)
    setDownloadProgress(null)
    setMeasurement(null)
    setRecordedDataTree({})
    setResultContracts(null)
    setResultErrors({})
  }, [cancelActiveQueries])

  useEffect(
    () => () => {
      requestedMeasurementId.current = null
      requestSequence.current += 1
      cancelActiveQueries()
    },
    [cancelActiveQueries, queryScope],
  )

  const loadMeasurement = useCallback(
    async (
      value: number | SavedMeasurement,
      expectedExperimentId: number | null = experimentId,
      options: Readonly<{ expectedSelectionId?: number | null }> = {},
    ) => {
      const id = typeof value === 'number' ? value : value.id
      // A result event must not replace a newer selection still being fetched.
      if (options.expectedSelectionId !== undefined && requestedMeasurementId.current !== options.expectedSelectionId)
        return null
      requestedMeasurementId.current = id
      const sequence = ++requestSequence.current
      cancelActiveQueries()
      setLoading(true)
      setDownloadProgress(null)
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
        if (sequence !== requestSequence.current) return null
        const recordedDataOptions = measurementRecordedDataQueryOptions(queryScope, row.id, (progress) => {
          if (sequence === requestSequence.current) setDownloadProgress(progress)
        })
        activeQueryKeys.current = [recordedDataOptions.queryKey]
        const recorded = await queryClient.fetchQuery(recordedDataOptions)
        if (sequence !== requestSequence.current) return null
        setMeasurement(row)
        setRecordedDataTree(recorded.recorded_data)
        setResultContracts(recorded.result_contracts)
        setResultErrors(recorded.result_errors ?? {})
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
      resultContracts,
      resultErrors,
      measurement,
      recordedRows: snapshot.rows,
      recordedData: snapshot.data,
      flatRecordedData: snapshot.flatData,
      recordedRules: snapshot.rules,
      recordedSchemas: snapshot.schemas,
      variables: measurement?.vars as Readonly<Vars> | undefined,
      materialSnapshot: measurement?.material_snapshot ?? null,
      loading,
      downloadProgress,
      clearAll: clearMeasurement,
      clearMeasurement,
      loadMeasurement,
    }),
    [
      clearMeasurement,
      downloadProgress,
      loadMeasurement,
      loading,
      measurement,
      snapshot,
      resultContracts,
      resultErrors,
    ],
  )
}

export type CaeDataSelection = ReturnType<typeof useCaeDataSelection>
