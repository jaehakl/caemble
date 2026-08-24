import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type MeasurementRecordRequest } from '@/api'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import { createDataTensorAccessor, MAX_RECORDED_DATA_BYTES, persistDataSchema, persistDataTensor } from '@/lib/cad'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedMeasurement } from '../types'

type GenerateAndRunState = Readonly<{
  baselineRevision: number
  candidateGeneration: number
  experimentId: number
  measurementId: number | null
  phase: 'candidate' | 'measurement' | 'running' | 'saving'
  sequence: number
  sourceHash: string
}>

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
  onGenerateCandidate: () => number | null
  selection: CaeDataSelection
  simulation: SimulationController
}) {
  const queryClient = useQueryClient()
  const [operation, setOperation] = useState<
    'candidate' | 'delete' | 'generate-and-run' | 'measurement' | 'record' | 'save' | null
  >(null)
  const [generateAndRunState, setGenerateAndRunState] = useState<GenerateAndRunState | null>(null)
  const [stage, setStage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRecordMeasurementId, setPendingRecordMeasurementId] = useState<number | null>(null)
  const activeMeasurementId = useRef<number | null>(null)
  const generateAndRunSequence = useRef(0)
  const generateAndRunStep = useRef<GenerateAndRunState['phase'] | null>(null)
  const pendingRecordRequest = useRef<MeasurementRecordRequest | null>(null)
  const experimentIdentityRef = useRef({ experimentClean, experimentId, experimentSourceHash })
  const experimentDocumentRef = useRef(experimentDocument)
  const simulationRef = useRef(simulation)
  experimentIdentityRef.current = { experimentClean, experimentId, experimentSourceHash }
  experimentDocumentRef.current = experimentDocument
  simulationRef.current = simulation

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback
    setError(message)
    toast.error(message)
  }, [])

  const finishGenerateAndRun = useCallback((sequence: number) => {
    if (generateAndRunSequence.current !== sequence) return false
    generateAndRunSequence.current += 1
    generateAndRunStep.current = null
    activeMeasurementId.current = null
    setGenerateAndRunState(null)
    setOperation(null)
    setStage(null)
    return true
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
    if (experimentDocument.draftTaskNames.length > 0) {
      throw new Error('Solver가 선택되지 않은 Draft Task가 있어 Measurement를 저장할 수 없습니다.')
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
      if (onGenerateCandidate() === null) throw new Error('Candidate 생성을 시작하지 못했습니다.')
    } catch (cause) {
      fail(cause, 'Candidate를 생성하지 못했습니다.')
    } finally {
      setOperation(null)
      setStage(null)
    }
  }, [experimentDocument.runIsBusy, fail, onGenerateCandidate, operation, pendingRecordMeasurementId])

  const generateAndRun = useCallback(() => {
    if (operation || generateAndRunStep.current || pendingRecordMeasurementId || experimentDocument.runIsBusy) {
      return false
    }
    setError(null)
    try {
      if (!authenticated) throw new Error('로그인이 필요합니다.')
      if (!experimentClean || !experimentId || !experimentSourceHash) {
        throw new Error('저장되고 편집되지 않은 Experiment가 필요합니다.')
      }
      if (experimentDocument.draftTaskNames.length > 0) {
        throw new Error('Solver가 선택되지 않은 Draft Task가 있어 Measurement를 저장할 수 없습니다.')
      }
      const sequence = generateAndRunSequence.current + 1
      generateAndRunSequence.current = sequence
      generateAndRunStep.current = 'candidate'
      const candidateGeneration = onGenerateCandidate()
      if (candidateGeneration === null) throw new Error('Candidate 생성을 시작하지 못했습니다.')
      setGenerateAndRunState({
        baselineRevision: experimentDocument.revision,
        candidateGeneration,
        experimentId,
        measurementId: null,
        phase: 'candidate',
        sequence,
        sourceHash: experimentSourceHash,
      })
      setOperation('generate-and-run')
      setStage('Candidate 생성')
      return true
    } catch (cause) {
      generateAndRunStep.current = null
      setGenerateAndRunState(null)
      setOperation(null)
      setStage(null)
      fail(cause, 'Generate & Run을 시작하지 못했습니다.')
      return false
    }
  }, [
    authenticated,
    experimentClean,
    experimentDocument.draftTaskNames.length,
    experimentDocument.revision,
    experimentDocument.runIsBusy,
    experimentId,
    experimentSourceHash,
    fail,
    onGenerateCandidate,
    operation,
    pendingRecordMeasurementId,
  ])

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

  const deleteMeasurements = useCallback(
    async (rows: readonly SavedMeasurement[]) => {
      if (operation || pendingRecordMeasurementId) return false
      setError(null)
      setOperation('delete')
      setStage('Measurement 삭제')
      try {
        const ids = rows.map((row) => row.id)
        await dbTables.Measurement.deleteRows(ids)
        if (selection.measurement && ids.includes(selection.measurement.id)) selection.clearMeasurement()
        await invalidate().catch(() => undefined)
        toast.success(`Measurement ${ids.length.toLocaleString()}개를 삭제했습니다.`)
        return true
      } catch (cause) {
        fail(cause, 'Measurement를 삭제하지 못했습니다.')
        return false
      } finally {
        setOperation(null)
        setStage(null)
      }
    },
    [fail, invalidate, operation, pendingRecordMeasurementId, selection],
  )

  useEffect(() => {
    if (operation !== 'generate-and-run' || !generateAndRunState) return
    if (
      experimentClean &&
      experimentId === generateAndRunState.experimentId &&
      experimentSourceHash === generateAndRunState.sourceHash
    ) {
      return
    }
    if (generateAndRunState.phase === 'running') simulation.cancel()
    if (finishGenerateAndRun(generateAndRunState.sequence)) {
      fail(
        new Error(
          'Experiment가 변경되어 Generate & Run을 중단했습니다. 이미 저장된 Prepared Measurement는 유지됩니다.',
        ),
        '',
      )
    }
  }, [
    experimentClean,
    experimentId,
    experimentSourceHash,
    fail,
    finishGenerateAndRun,
    generateAndRunState,
    operation,
    simulation,
  ])

  useEffect(() => {
    const state = generateAndRunState
    if (
      operation !== 'generate-and-run' ||
      !state ||
      state.phase !== 'candidate' ||
      generateAndRunStep.current !== 'candidate' ||
      experimentDocument.revision <= state.baselineRevision
    ) {
      return
    }
    if (experimentDocument.completedCandidateGeneration < state.candidateGeneration) return
    if (
      experimentDocument.completedCandidateGeneration !== state.candidateGeneration ||
      experimentDocument.successfulCandidateGeneration !== state.candidateGeneration
    ) {
      if (finishGenerateAndRun(state.sequence)) {
        fail(
          new Error(
            experimentDocument.error?.message ??
              (experimentDocument.completedCandidateGeneration > state.candidateGeneration
                ? '새 Candidate 생성 요청이 다른 요청으로 대체되었습니다.'
                : '새 Candidate 평가에 실패했습니다.'),
          ),
          '새 Candidate 평가에 실패했습니다.',
        )
      }
      return
    }
    if (experimentDocument.status === 'Error') {
      if (finishGenerateAndRun(state.sequence)) {
        fail(
          new Error(experimentDocument.error?.message ?? '새 Candidate 평가에 실패했습니다.'),
          '새 Candidate 평가에 실패했습니다.',
        )
      }
      return
    }
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision
    ) {
      return
    }

    generateAndRunStep.current = 'saving'
    setGenerateAndRunState({ ...state, phase: 'saving' })
    setStage('Measurement 저장')
    void (async () => {
      try {
        const request = requireSavableCandidate()
        const { id } = await dbTables.Measurement.create(request)
        if (generateAndRunSequence.current !== state.sequence) return
        const identity = experimentIdentityRef.current
        if (
          !identity.experimentClean ||
          identity.experimentId !== state.experimentId ||
          identity.experimentSourceHash !== state.sourceHash
        ) {
          throw new Error(
            'Experiment가 변경되어 Generate & Run을 중단했습니다. 저장된 Prepared Measurement는 유지됩니다.',
          )
        }
        const measurementState: GenerateAndRunState = {
          ...state,
          baselineRevision: experimentDocumentRef.current.revision,
          measurementId: id,
          phase: 'measurement',
        }
        generateAndRunStep.current = 'measurement'
        setGenerateAndRunState(measurementState)
        setStage('Measurement 평가')
        const row = await refreshPersistedMeasurement(id, state.experimentId)
        if (generateAndRunSequence.current !== state.sequence) return
        if (!row) {
          const message = `Measurement #${id}은 저장되었지만 Generate & Run을 계속할 수 없습니다.`
          if (finishGenerateAndRun(state.sequence)) setError(message)
        }
      } catch (cause) {
        if (finishGenerateAndRun(state.sequence)) fail(cause, 'Measurement를 저장하지 못했습니다.')
      }
    })()
  }, [
    experimentDocument.error?.message,
    experimentDocument.completedCandidateGeneration,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulCandidateGeneration,
    experimentDocument.successfulRevision,
    fail,
    finishGenerateAndRun,
    generateAndRunState,
    operation,
    refreshPersistedMeasurement,
    requireSavableCandidate,
  ])

  useEffect(() => {
    const state = generateAndRunState
    if (
      operation !== 'generate-and-run' ||
      !state ||
      state.phase !== 'measurement' ||
      generateAndRunStep.current !== 'measurement' ||
      !state.measurementId
    ) {
      return
    }
    if (selection.measurement && selection.measurement.id !== state.measurementId) {
      if (finishGenerateAndRun(state.sequence)) {
        fail(new Error('Generate & Run을 위해 저장한 Measurement 선택이 변경되었습니다.'), '')
      }
      return
    }
    if (!selection.measurement || experimentDocument.revision <= state.baselineRevision) return
    if (experimentDocument.status === 'Error') {
      if (finishGenerateAndRun(state.sequence)) {
        fail(
          new Error(experimentDocument.error?.message ?? '저장된 Measurement 평가에 실패했습니다.'),
          '저장된 Measurement 평가에 실패했습니다.',
        )
      }
      return
    }
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision
    ) {
      return
    }
    if (!simulation.canRun) {
      if (finishGenerateAndRun(state.sequence)) {
        fail(new Error('저장된 Measurement를 실행할 수 없습니다.'), '')
      }
      return
    }

    generateAndRunStep.current = 'running'
    setGenerateAndRunState({ ...state, phase: 'running' })
    pendingRecordRequest.current = null
    activeMeasurementId.current = state.measurementId
    setStage('Simulation 실행')
    const runId = simulation.run()
    if (!runId) {
      activeMeasurementId.current = null
      if (finishGenerateAndRun(state.sequence)) fail(new Error('Simulation을 시작하지 못했습니다.'), '')
    }
  }, [
    experimentDocument.error?.message,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    fail,
    finishGenerateAndRun,
    generateAndRunState,
    operation,
    selection.measurement,
    simulation,
  ])

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
  }, [experimentClean, experimentId, fail, operation, pendingRecordMeasurementId, selection.measurement, simulation])

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
    const generateAndRunSequenceId =
      operation === 'generate-and-run' && generateAndRunState?.phase === 'running' ? generateAndRunState.sequence : null
    if (operation !== 'measurement' && generateAndRunSequenceId === null) return
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
          if (generateAndRunSequenceId !== null) finishGenerateAndRun(generateAndRunSequenceId)
          else {
            setOperation(null)
            setStage(null)
          }
        }
      })()
      return
    }
    if (simulation.process.status === 'failed' || simulation.process.status === 'cancelled') {
      activeMeasurementId.current = null
      fail(simulation.process.error ?? 'Simulation이 완료되지 않았습니다.', 'Simulation이 완료되지 않았습니다.')
      if (generateAndRunSequenceId !== null) finishGenerateAndRun(generateAndRunSequenceId)
      else {
        setOperation(null)
        setStage(null)
      }
    }
  }, [
    fail,
    finishGenerateAndRun,
    generateAndRunState?.phase,
    generateAndRunState?.sequence,
    operation,
    persistRecordedData,
    simulation.process.error,
    simulation.process.stage,
    simulation.process.status,
  ])

  const cancel = useCallback(() => {
    if (
      operation !== 'measurement' &&
      !(operation === 'generate-and-run' && generateAndRunState?.phase === 'running')
    ) {
      return
    }
    simulation.cancel()
  }, [generateAndRunState?.phase, operation, simulation])

  const cancelable =
    (operation === 'measurement' || (operation === 'generate-and-run' && generateAndRunState?.phase === 'running')) &&
    ['preparing', 'running'].includes(simulation.process.status)

  return {
    busy: operation !== null,
    cancel,
    cancelable,
    deleteMeasurements,
    error,
    generateAndRun,
    generateCandidate,
    operation,
    pendingRecordMeasurementId,
    retryRecord,
    runSelected,
    saveCurrent,
    stage,
  }
}
