import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type MeasurementRecordRequest } from '@/api'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import { createDataTensorAccessor, MAX_RECORDED_DATA_BYTES, persistDataSchema, persistDataTensor } from '@/lib/cad'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedMeasurement } from '../types'

function recordRequest(
  experimentDocument: CadDocumentController,
  simulation: SimulationController,
): MeasurementRecordRequest {
  const result = simulation.recordedData
  const schemas = experimentDocument.simulationProgram?.recordedData
  if (!result || !schemas || simulation.stale) throw new Error('저장 가능한 최신 RecordedData가 없습니다.')

  let recordedByteLength = 0
  const recordedData = Object.entries(result).map(([name, data]) => {
    const spec = schemas[name]
    if (!spec) throw new Error(`RecordedData ${JSON.stringify(name)} schema가 없습니다.`)
    const { tensorOrder, ...dataSchema } = spec
    const accessor = createDataTensorAccessor(spec, data, `RecordedData ${JSON.stringify(name)}`)
    recordedByteLength += accessor.byteLength
    if (recordedByteLength > MAX_RECORDED_DATA_BYTES) {
      throw new Error(`RecordedData raw bytes exceed the ${MAX_RECORDED_DATA_BYTES / 1024 / 1024} MiB Run limit.`)
    }
    return {
      name,
      quantity_kind: spec.quantityKind ?? null,
      tensor_order: tensorOrder,
      dtype: spec.dtype,
      data_schema: persistDataSchema(dataSchema),
      data: persistDataTensor(spec, data, `RecordedData ${JSON.stringify(name)}`),
    }
  })
  return { recorded_data: recordedData }
}

export function useCaeMeasurementActions({
  authenticated,
  experimentClean,
  experimentDocument,
  experimentId,
  experimentSourceHash,
  onGenerateCandidate,
  selection,
  simulation,
}: {
  authenticated: boolean
  experimentClean: boolean
  experimentDocument: CadDocumentController
  experimentId: number | null
  experimentSourceHash: string | null
  onGenerateCandidate: () => void
  selection: CaeDataSelection
  simulation: SimulationController
}) {
  const queryClient = useQueryClient()
  const [operation, setOperation] = useState<'candidate' | 'duplicate' | 'measurement' | 'record' | 'save' | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRecordMeasurementId, setPendingRecordMeasurementId] = useState<number | null>(null)
  const activeMeasurementId = useRef<number | null>(null)
  const pendingRecordRequest = useRef<MeasurementRecordRequest | null>(null)
  const experimentDocumentRef = useRef(experimentDocument)
  const simulationRef = useRef(simulation)
  experimentDocumentRef.current = experimentDocument
  simulationRef.current = simulation

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback
    setError(message)
    toast.error(message)
  }, [])

  const invalidate = useCallback(
    async (measurementId?: number) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] }),
        queryClient.invalidateQueries({ queryKey: ['analysis', experimentId] }),
        ...(measurementId
          ? [queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'recorded-data', measurementId] })]
          : []),
      ])
    },
    [experimentId, queryClient],
  )

  const refreshPersistedMeasurement = useCallback(
    async (measurementId: number, selectedExperimentId: number | null) => {
      await invalidate(measurementId).catch(() => undefined)
      try {
        const row = await selection.loadMeasurement(measurementId, selectedExperimentId)
        if (!row) throw new Error('Measurement refresh was superseded.')
        return row
      } catch {
        selection.clearMeasurement()
        toast.error(
          `Measurement #${measurementId}은 서버에 저장되었지만 화면을 새로 고치지 못했습니다. 목록에서 다시 선택하세요.`,
        )
        return null
      }
    },
    [invalidate, selection],
  )

  const requireSavableCandidate = useCallback(() => {
    if (!authenticated) throw new Error('로그인이 필요합니다.')
    if (!experimentClean || !experimentId || !experimentSourceHash) {
      throw new Error('저장되고 편집되지 않은 Experiment가 필요합니다.')
    }
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision ||
      !experimentDocument.variables ||
      !experimentDocument.materialParameters
    ) {
      throw new Error('저장할 Candidate 평가가 완료되지 않았습니다.')
    }
    return {
      experiment_id: experimentId,
      experiment_source_hash: experimentSourceHash,
      vars: experimentDocument.variables,
      material_parameters: experimentDocument.materialParameters,
    }
  }, [authenticated, experimentClean, experimentDocument, experimentId, experimentSourceHash])

  const generateCandidate = useCallback(() => {
    if (operation || pendingRecordMeasurementId || experimentDocument.runIsBusy) return
    setError(null)
    setOperation('candidate')
    setStage('Candidate 생성')
    try {
      onGenerateCandidate()
    } catch (cause) {
      fail(cause, 'Candidate를 생성하지 못했습니다.')
    } finally {
      setOperation(null)
      setStage(null)
    }
  }, [experimentDocument.runIsBusy, fail, onGenerateCandidate, operation, pendingRecordMeasurementId])

  const saveCurrent = useCallback(async () => {
    if (operation || pendingRecordMeasurementId) return null
    setError(null)
    setOperation('save')
    setStage('Measurement 저장')
    try {
      const request = requireSavableCandidate()
      const { id } = await dbTables.Measurement.create(request)
      if (await refreshPersistedMeasurement(id, request.experiment_id)) {
        toast.success(`Measurement #${id}을 준비했습니다.`)
      }
      return id
    } catch (cause) {
      fail(cause, 'Measurement를 저장하지 못했습니다.')
      return null
    } finally {
      setOperation(null)
      setStage(null)
    }
  }, [fail, operation, pendingRecordMeasurementId, refreshPersistedMeasurement, requireSavableCandidate])

  const duplicateMeasurement = useCallback(
    async (row: SavedMeasurement) => {
      if (operation || pendingRecordMeasurementId) return null
      setError(null)
      setOperation('duplicate')
      setStage('Measurement 복제')
      try {
        const current = requireSavableCandidate()
        if (row.experiment_id !== current.experiment_id) {
          throw new Error('현재 저장된 Experiment의 Measurement만 복제할 수 있습니다.')
        }
        const { id } = await dbTables.Measurement.create({
          experiment_id: current.experiment_id,
          experiment_source_hash: current.experiment_source_hash,
          vars: row.vars,
          material_parameters: row.material_parameters,
        })
        if (await refreshPersistedMeasurement(id, current.experiment_id)) {
          toast.success(`Measurement #${row.id}을 #${id}으로 복제했습니다.`)
        }
        return id
      } catch (cause) {
        fail(cause, 'Measurement를 복제하지 못했습니다.')
        return null
      } finally {
        setOperation(null)
        setStage(null)
      }
    },
    [
      fail,
      operation,
      pendingRecordMeasurementId,
      refreshPersistedMeasurement,
      requireSavableCandidate,
    ],
  )

  const runSelected = useCallback(() => {
    const measurement = selection.measurement
    if (operation || pendingRecordMeasurementId || !measurement) return null
    if (measurement.recorded_at) {
      fail(new Error('이미 RecordedData가 있는 Measurement는 다시 실행할 수 없습니다.'), '')
      return null
    }
    if (!experimentClean || measurement.experiment_id !== experimentId) {
      fail(new Error('Measurement와 현재 Experiment revision이 일치하지 않습니다.'), '')
      return null
    }
    if (!simulation.canRun) {
      fail(new Error('선택한 Measurement 평가가 완료된 뒤 실행하세요.'), '')
      return null
    }
    setError(null)
    pendingRecordRequest.current = null
    activeMeasurementId.current = measurement.id
    setOperation('measurement')
    setStage('Simulation 실행')
    const runId = simulation.run()
    if (!runId) {
      activeMeasurementId.current = null
      setOperation(null)
      setStage(null)
      fail(new Error('Simulation을 시작하지 못했습니다.'), '')
    }
    return runId
  }, [
    experimentClean,
    experimentId,
    fail,
    operation,
    pendingRecordMeasurementId,
    selection.measurement,
    simulation,
  ])

  const persistRecordedData = useCallback(
    async (measurementId: number, request: MeasurementRecordRequest) => {
      try {
        await dbTables.Measurement.record(measurementId, request)
      } catch (cause) {
        if ((cause as { status?: unknown })?.status !== 409) throw cause
        const row = await selection.loadMeasurement(measurementId, experimentId).catch(() => null)
        if (!row?.recorded_at) throw cause
        setPendingRecordMeasurementId(null)
        pendingRecordRequest.current = null
        await invalidate(measurementId).catch(() => undefined)
        toast.success(`Measurement #${measurementId}의 RecordedData는 이미 저장되어 있었습니다.`)
        return
      }
      setPendingRecordMeasurementId(null)
      pendingRecordRequest.current = null
      if (await refreshPersistedMeasurement(measurementId, experimentId)) {
        toast.success(`Measurement #${measurementId}의 RecordedData를 저장했습니다.`)
      }
    },
    [experimentId, invalidate, refreshPersistedMeasurement, selection],
  )

  const retryRecord = useCallback(async () => {
    const measurementId = pendingRecordMeasurementId
    const request = pendingRecordRequest.current
    if (!measurementId || !request || operation) return false
    setError(null)
    setOperation('record')
    setStage('RecordedData 다시 저장')
    try {
      await persistRecordedData(measurementId, request)
      return true
    } catch (cause) {
      fail(cause, 'RecordedData를 다시 저장하지 못했습니다.')
      return false
    } finally {
      setOperation(null)
      setStage(null)
    }
  }, [fail, operation, pendingRecordMeasurementId, persistRecordedData])

  useEffect(() => {
    if (operation !== 'measurement') return
    const measurementId = activeMeasurementId.current
    if (!measurementId) return
    if (simulation.process.status === 'preparing' || simulation.process.status === 'running') {
      setStage(simulation.process.stage ?? 'Simulation 실행')
      return
    }
    if (simulation.process.status === 'succeeded') {
      activeMeasurementId.current = null
      setStage('RecordedData 저장')
      void (async () => {
        try {
          const request = recordRequest(experimentDocumentRef.current, simulationRef.current)
          pendingRecordRequest.current = request
          await persistRecordedData(measurementId, request)
        } catch (cause) {
          if (pendingRecordRequest.current) setPendingRecordMeasurementId(measurementId)
          fail(cause, 'RecordedData를 저장하지 못했습니다.')
        } finally {
          setOperation(null)
          setStage(null)
        }
      })()
      return
    }
    if (simulation.process.status === 'failed' || simulation.process.status === 'cancelled') {
      activeMeasurementId.current = null
      fail(simulation.process.error ?? 'Simulation이 완료되지 않았습니다.', 'Simulation이 완료되지 않았습니다.')
      setOperation(null)
      setStage(null)
    }
  }, [
    fail,
    operation,
    persistRecordedData,
    simulation.process.error,
    simulation.process.stage,
    simulation.process.status,
  ])

  const cancel = useCallback(() => {
    if (operation !== 'measurement') return
    simulation.cancel()
  }, [operation, simulation])

  return {
    busy: operation !== null,
    cancel,
    cancelable: operation === 'measurement' && ['preparing', 'running'].includes(simulation.process.status),
    duplicateMeasurement,
    error,
    generateCandidate,
    operation,
    pendingRecordMeasurementId,
    retryRecord,
    runSelected,
    saveCurrent,
    stage,
  }
}
