import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dbTables, getListRequest } from '@/api'
import type { Vars } from '@/lib/cad'
import { recordedDataSnapshot } from './recordedData'
import type { SavedMeasurement, SavedRecordedData, SavedSample, SavedSetup } from '../types'

async function fetchScoped<T extends { id?: number }>(
  id: number,
  list: (request: ReturnType<typeof getListRequest>) => Promise<{ items: T[] }>,
  label: string,
  scope: 'mine' | 'visible',
) {
  const row = (await list(getListRequest(scope, [id]))).items[0]
  if (!row?.id) throw new Error(`${label} #${id}을 찾을 수 없습니다.`)
  return row as T & { id: number }
}

export function useCaeDataSelection(
  structureId: number | null,
  experimentId: number | null,
  scope: 'mine' | 'visible' = 'mine',
) {
  const [sample, setSample] = useState<SavedSample | null>(null)
  const [setup, setSetup] = useState<SavedSetup | null>(null)
  const [measurement, setMeasurement] = useState<SavedMeasurement | null>(null)
  const [recordedRows, setRecordedRows] = useState<readonly SavedRecordedData[]>([])
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)
  const sampleRequestSequence = useRef(0)
  const setupRequestSequence = useRef(0)
  const previousPair = useRef({ experimentId, structureId })

  const clearMeasurement = useCallback(() => {
    requestSequence.current += 1
    setLoading(false)
    setMeasurement(null)
    setRecordedRows([])
  }, [])

  const clearSample = useCallback(() => {
    sampleRequestSequence.current += 1
    setSample(null)
    clearMeasurement()
  }, [clearMeasurement])

  const clearSetup = useCallback(() => {
    setupRequestSequence.current += 1
    setSetup(null)
    clearMeasurement()
  }, [clearMeasurement])

  const clearAll = useCallback(() => {
    sampleRequestSequence.current += 1
    setupRequestSequence.current += 1
    setSample(null)
    setSetup(null)
    clearMeasurement()
  }, [clearMeasurement])

  useEffect(() => {
    const previous = previousPair.current
    previousPair.current = { experimentId, structureId }
    if (previous.structureId !== structureId) clearSample()
    if (previous.experimentId !== experimentId) clearSetup()
  }, [clearSample, clearSetup, experimentId, structureId])

  const selectSample = useCallback(
    async (value: number | SavedSample) => {
      const sequence = ++sampleRequestSequence.current
      const row =
        typeof value === 'number'
          ? await fetchScoped(value, (request) => dbTables.Sample.listRows(request), 'Sample', scope)
          : value
      if (structureId !== null && row.structure_id !== structureId) {
        throw new Error('현재 Structure에 속한 Sample이 아닙니다.')
      }
      if (sequence !== sampleRequestSequence.current) return null
      setSample(row)
      clearMeasurement()
      return row
    },
    [clearMeasurement, scope, structureId],
  )

  const selectSetup = useCallback(
    async (value: number | SavedSetup) => {
      const sequence = ++setupRequestSequence.current
      const row =
        typeof value === 'number'
          ? await fetchScoped(value, (request) => dbTables.Setup.listRows(request), 'Setup', scope)
          : value
      if (experimentId !== null && row.experiment_id !== experimentId) {
        throw new Error('현재 Experiment에 속한 Setup이 아닙니다.')
      }
      if (sequence !== setupRequestSequence.current) return null
      setSetup(row)
      clearMeasurement()
      return row
    },
    [clearMeasurement, experimentId, scope],
  )

  const loadMeasurement = useCallback(
    async (id: number, expectedPair: Readonly<{ structureId: number; experimentId: number }> | null = null) => {
      const sequence = ++requestSequence.current
      const sampleSequence = ++sampleRequestSequence.current
      const setupSequence = ++setupRequestSequence.current
      setLoading(true)
      try {
        const row = await fetchScoped(id, (request) => dbTables.Measurement.listRows(request), 'Measurement', scope)
        const [nextSample, nextSetup, recorded] = await Promise.all([
          fetchScoped(row.sample_id, (request) => dbTables.Sample.listRows(request), 'Sample', scope),
          fetchScoped(row.setup_id, (request) => dbTables.Setup.listRows(request), 'Setup', scope),
          dbTables.RecordedData.listRows({
            ...getListRequest(scope),
            limit: null,
            filter: { measurement_id: [id, id] },
          }),
        ])
        const requiredStructureId = expectedPair?.structureId ?? structureId
        const requiredExperimentId = expectedPair?.experimentId ?? experimentId
        if (requiredStructureId !== null && nextSample.structure_id !== requiredStructureId) {
          throw new Error('Measurement의 Sample이 현재 Structure와 일치하지 않습니다.')
        }
        if (requiredExperimentId !== null && nextSetup.experiment_id !== requiredExperimentId) {
          throw new Error('Measurement의 Setup이 현재 Experiment와 일치하지 않습니다.')
        }
        if (
          sequence !== requestSequence.current ||
          sampleSequence !== sampleRequestSequence.current ||
          setupSequence !== setupRequestSequence.current
        ) {
          return null
        }
        setSample(nextSample)
        setSetup(nextSetup)
        setMeasurement(row)
        setRecordedRows(recorded.items as SavedRecordedData[])
        return row
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [experimentId, scope, structureId],
  )

  const snapshot = useMemo(() => recordedDataSnapshot(recordedRows), [recordedRows])

  return {
    sample,
    setup,
    measurement,
    recordedRows,
    recordedData: snapshot.data,
    recordedRules: snapshot.rules,
    structureVars: sample?.vars as Readonly<Vars> | undefined,
    experimentVars: setup?.vars as Readonly<Vars> | undefined,
    structureMaterialSnapshot: sample?.material_parameters ?? null,
    experimentMaterialSnapshot: setup?.material_parameters ?? null,
    loading,
    clearAll,
    clearMeasurement,
    clearSample,
    clearSetup,
    loadMeasurement,
    selectSample,
    selectSetup,
    setGeneratedSample: (row: SavedSample) => {
      sampleRequestSequence.current += 1
      setSample(row)
      clearMeasurement()
    },
    setGeneratedSetup: (row: SavedSetup) => {
      setupRequestSequence.current += 1
      setSetup(row)
      clearMeasurement()
    },
  }
}

export type CaeDataSelection = ReturnType<typeof useCaeDataSelection>
