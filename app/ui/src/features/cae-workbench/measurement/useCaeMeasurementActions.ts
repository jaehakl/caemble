import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type MeasurementRecordRequest } from '@/api'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import { createDataTensorAccessor, MAX_RECORDED_DATA_BYTES, persistDataSchema, persistDataTensor } from '@/lib/cad'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedMeasurement } from '../types'

type GenerateAndRunState = Readonly<{
  attempt: number
  baselineRevision: number
  candidateGeneration: number
  experimentId: number
  failures: number
  measurementId: number | null
  phase: 'candidate' | 'measurement' | 'running' | 'saving'
  repeat: boolean
  sequence: number
  sourceHash: string
  successes: number
  total: number
}>

function generateAndRunStage(state: GenerateAndRunState, value: string) {
  return state.repeat ? `${state.attempt}/${state.total} · ${value}` : value
}

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
  const generateAndRunCancelRequested = useRef(false)
  const generateAndRunSequence = useRef(0)
  const generateAndRunStep = useRef<GenerateAndRunState['phase'] | null>(null)
  const onGenerateCandidateRef = useRef(onGenerateCandidate)
  const pendingRecordRequest = useRef<MeasurementRecordRequest | null>(null)
  const experimentIdentityRef = useRef({ experimentClean, experimentId, experimentSourceHash })
  const experimentDocumentRef = useRef(experimentDocument)
  const simulationRef = useRef(simulation)
  experimentIdentityRef.current = { experimentClean, experimentId, experimentSourceHash }
  experimentDocumentRef.current = experimentDocument
  onGenerateCandidateRef.current = onGenerateCandidate
  simulationRef.current = simulation

  const fail = useCallback((cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback
    setError(message)
    toast.error(message)
  }, [])

  const finishGenerateAndRun = useCallback(
    (sequence: number, summary?: Pick<GenerateAndRunState, 'failures' | 'repeat' | 'successes' | 'total'>) => {
      if (generateAndRunSequence.current !== sequence) return false
      generateAndRunSequence.current += 1
      generateAndRunStep.current = null
      generateAndRunCancelRequested.current = false
      activeMeasurementId.current = null
      setGenerateAndRunState(null)
      setOperation(null)
      setStage(null)
      if (summary?.repeat) {
        const message = `Repeat Run ${summary.total.toLocaleString()}회 완료: 성공 ${summary.successes.toLocaleString()}회, 실패 ${summary.failures.toLocaleString()}회`
        if (summary.failures > 0) toast.warning(message)
        else toast.success(message)
      }
      return true
    },
    [],
  )

  const startGenerateAndRunAttempt = useCallback((state: GenerateAndRunState) => {
    if (generateAndRunSequence.current !== state.sequence) return false
    const candidateGeneration = onGenerateCandidateRef.current()
    if (candidateGeneration === null) return false
    const nextState: GenerateAndRunState = {
      ...state,
      baselineRevision: experimentDocumentRef.current.revision,
      candidateGeneration,
      measurementId: null,
      phase: 'candidate',
    }
    generateAndRunStep.current = 'candidate'
    setGenerateAndRunState(nextState)
    setStage(generateAndRunStage(nextState, 'Candidate 생성'))
    return true
  }, [])

  const advanceGenerateAndRun = useCallback(
    (state: GenerateAndRunState, succeeded: boolean) => {
      if (generateAndRunSequence.current !== state.sequence) return false
      const completed: GenerateAndRunState = {
        ...state,
        failures: state.failures + (succeeded ? 0 : 1),
        successes: state.successes + (succeeded ? 1 : 0),
      }
      if (state.attempt >= state.total) {
        return finishGenerateAndRun(state.sequence, completed)
      }
      const nextState: GenerateAndRunState = {
        ...completed,
        attempt: state.attempt + 1,
      }
      try {
        if (startGenerateAndRunAttempt(nextState)) return true
        throw new Error('다음 Candidate 생성을 시작하지 못해 Repeat Run을 중단했습니다.')
      } catch (cause) {
        finishGenerateAndRun(state.sequence)
        fail(cause, '다음 Candidate 생성을 시작하지 못해 Repeat Run을 중단했습니다.')
      }
      return false
    },
    [fail, finishGenerateAndRun, startGenerateAndRunAttempt],
  )

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

  const startGenerateAndRun = useCallback(
    (total: number, repeat: boolean) => {
      if (operation || generateAndRunStep.current || pendingRecordMeasurementId || experimentDocument.runIsBusy) {
        return false
      }
      setError(null)
      try {
        if (!Number.isSafeInteger(total) || total < 1) {
          throw new Error('반복 횟수는 양의 정수여야 합니다.')
        }
        if (!authenticated) throw new Error('로그인이 필요합니다.')
        if (!experimentClean || !experimentId || !experimentSourceHash) {
          throw new Error('저장되고 편집되지 않은 Experiment가 필요합니다.')
        }
        if (experimentDocument.draftTaskNames.length > 0) {
          throw new Error('Solver가 선택되지 않은 Draft Task가 있어 Measurement를 저장할 수 없습니다.')
        }
        const sequence = generateAndRunSequence.current + 1
        generateAndRunSequence.current = sequence
        generateAndRunCancelRequested.current = false
        generateAndRunStep.current = 'candidate'
        setOperation('generate-and-run')
        const initialState: GenerateAndRunState = {
          attempt: 1,
          baselineRevision: experimentDocument.revision,
          candidateGeneration: 0,
          experimentId,
          failures: 0,
          measurementId: null,
          phase: 'candidate',
          repeat,
          sequence,
          sourceHash: experimentSourceHash,
          successes: 0,
          total,
        }
        if (!startGenerateAndRunAttempt(initialState)) throw new Error('Candidate 생성을 시작하지 못했습니다.')
        return true
      } catch (cause) {
        generateAndRunSequence.current += 1
        generateAndRunStep.current = null
        setGenerateAndRunState(null)
        setOperation(null)
        setStage(null)
        fail(cause, repeat ? 'Repeat Run을 시작하지 못했습니다.' : 'Generate & Run을 시작하지 못했습니다.')
        return false
      }
    },
    [
      authenticated,
      experimentClean,
      experimentDocument.draftTaskNames.length,
      experimentDocument.revision,
      experimentDocument.runIsBusy,
      experimentId,
      experimentSourceHash,
      fail,
      operation,
      pendingRecordMeasurementId,
      startGenerateAndRunAttempt,
    ],
  )

  const generateAndRun = useCallback(() => startGenerateAndRun(1, false), [startGenerateAndRun])
  const repeatGenerateAndRun = useCallback((count: number) => startGenerateAndRun(count, true), [startGenerateAndRun])

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
      fail(
        new Error(
          experimentDocument.error?.message ??
            (experimentDocument.completedCandidateGeneration > state.candidateGeneration
              ? '새 Candidate 생성 요청이 다른 요청으로 대체되었습니다.'
              : '새 Candidate 평가에 실패했습니다.'),
        ),
        '새 Candidate 평가에 실패했습니다.',
      )
      advanceGenerateAndRun(state, false)
      return
    }
    if (experimentDocument.status === 'Error') {
      fail(
        new Error(experimentDocument.error?.message ?? '새 Candidate 평가에 실패했습니다.'),
        '새 Candidate 평가에 실패했습니다.',
      )
      advanceGenerateAndRun(state, false)
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
    setStage(generateAndRunStage(state, 'Measurement 저장'))
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
        setStage(generateAndRunStage(measurementState, 'Measurement 평가'))
        const row = await refreshPersistedMeasurement(id, state.experimentId)
        if (generateAndRunSequence.current !== state.sequence) return
        if (!row) {
          const message = `Measurement #${id}은 저장되었지만 Generate & Run을 계속할 수 없습니다.`
          setError(message)
          advanceGenerateAndRun(measurementState, false)
        }
      } catch (cause) {
        if (generateAndRunSequence.current !== state.sequence) return
        fail(cause, 'Measurement를 저장하지 못했습니다.')
        advanceGenerateAndRun(state, false)
      }
    })()
  }, [
    advanceGenerateAndRun,
    experimentDocument.error?.message,
    experimentDocument.completedCandidateGeneration,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulCandidateGeneration,
    experimentDocument.successfulRevision,
    fail,
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
      fail(new Error('Generate & Run을 위해 저장한 Measurement 선택이 변경되었습니다.'), '')
      advanceGenerateAndRun(state, false)
      return
    }
    if (!selection.measurement || experimentDocument.revision <= state.baselineRevision) return
    if (experimentDocument.status === 'Error') {
      fail(
        new Error(experimentDocument.error?.message ?? '저장된 Measurement 평가에 실패했습니다.'),
        '저장된 Measurement 평가에 실패했습니다.',
      )
      advanceGenerateAndRun(state, false)
      return
    }
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision
    ) {
      return
    }
    if (!simulation.canRun) {
      fail(new Error('저장된 Measurement를 실행할 수 없습니다.'), '')
      advanceGenerateAndRun(state, false)
      return
    }

    generateAndRunStep.current = 'running'
    setGenerateAndRunState({ ...state, phase: 'running' })
    pendingRecordRequest.current = null
    activeMeasurementId.current = state.measurementId
    setStage(generateAndRunStage(state, 'Simulation 실행'))
    const runId = simulation.run()
    if (!runId) {
      activeMeasurementId.current = null
      fail(new Error('Simulation을 시작하지 못했습니다.'), '')
      advanceGenerateAndRun(state, false)
    }
  }, [
    advanceGenerateAndRun,
    experimentDocument.error?.message,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    fail,
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
    const batchState =
      operation === 'generate-and-run' && generateAndRunState?.phase === 'running' ? generateAndRunState : null
    if (operation !== 'measurement' && !batchState) return
    const measurementId = activeMeasurementId.current
    if (!measurementId) return
    if (simulation.process.status === 'preparing' || simulation.process.status === 'running') {
      setStage(
        batchState
          ? generateAndRunStage(batchState, simulation.process.stage ?? 'Simulation 실행')
          : (simulation.process.stage ?? 'Simulation 실행'),
      )
      return
    }
    if (simulation.process.status === 'succeeded') {
      activeMeasurementId.current = null
      setStage(batchState ? generateAndRunStage(batchState, 'RecordedData 저장') : 'RecordedData 저장')
      void (async () => {
        try {
          const request = recordRequest(experimentDocumentRef.current, simulationRef.current)
          pendingRecordRequest.current = request
          await persistRecordedData(measurementId, request)
          if (batchState) advanceGenerateAndRun(batchState, true)
        } catch (cause) {
          if (pendingRecordRequest.current) setPendingRecordMeasurementId(measurementId)
          fail(cause, 'RecordedData를 저장하지 못했습니다.')
          if (batchState) finishGenerateAndRun(batchState.sequence)
        } finally {
          if (!batchState) {
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
      if (batchState) {
        if (generateAndRunCancelRequested.current) finishGenerateAndRun(batchState.sequence)
        else advanceGenerateAndRun(batchState, false)
      } else {
        setOperation(null)
        setStage(null)
      }
    }
  }, [
    advanceGenerateAndRun,
    fail,
    finishGenerateAndRun,
    generateAndRunState,
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
    if (operation === 'generate-and-run') generateAndRunCancelRequested.current = true
    simulation.cancel()
  }, [generateAndRunState?.phase, operation, simulation])

  const cancelable =
    (operation === 'measurement' || (operation === 'generate-and-run' && generateAndRunState?.phase === 'running')) &&
    ['preparing', 'running'].includes(simulation.process.status)

  const generateAndRunBatch = generateAndRunState
    ? Object.freeze({
        attempt: generateAndRunState.attempt,
        failures: generateAndRunState.failures,
        repeat: generateAndRunState.repeat,
        successes: generateAndRunState.successes,
        total: generateAndRunState.total,
      })
    : null

  return {
    busy: operation !== null,
    cancel,
    cancelable,
    deleteMeasurements,
    error,
    generateAndRun,
    generateAndRunBatch,
    generateCandidate,
    operation,
    pendingRecordMeasurementId,
    retryRecord,
    repeatGenerateAndRun,
    runSelected,
    saveCurrent,
    stage,
  }
}
