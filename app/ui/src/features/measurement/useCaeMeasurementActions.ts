import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type ExperimentRecordedDataRecord, type MeasurementRecordRequest } from '@/api'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import {
  persistDataTensor,
  type RecordedDataGroup,
  type RecordedDataNode,
  type RecordedDataTensor,
} from '@/lib/cad/model'
import type { ResolvedDataSchema, ResolvedDataSchemaNode } from '@/lib/cad/simulation'
import type { CaeDataSelection } from './useCaeDataSelection'
import {
  initialMeasurementLifecycleState,
  measurementLifecycleReducer,
  selectMeasurementLifecycle,
  type GenerateAndRunState,
  type SaveAndRunState,
} from './measurementLifecycle'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import type { CalculationDataActions, CalculationDataRunSummary } from '../calculation/useCalculationDataActions'
import { experimentRecordsQueryOptions } from '../experiment/queryOptions'
import { invalidateMeasurementMutation } from './queryInvalidation'

export type SaveAndRunCompletion = Readonly<{
  attemptId: number
  measurementId: number
  recordedDataSaved: true
  calculationSummary: CalculationDataRunSummary
}>

type SaveAndRunCompletionCallbacks = Readonly<{
  resolve: (completion: SaveAndRunCompletion) => void
  reject: (cause: Error) => void
}>

function isSchemaLeaf(value: ResolvedDataSchemaNode): value is ResolvedDataSchema {
  return 'dtype' in value && typeof value.dtype === 'string'
}

function generateAndRunStage(state: GenerateAndRunState, value: string) {
  return state.repeat ? `${state.attempt}/${state.total} · ${value}` : value
}

function recordRequest(
  experimentDocument: CadDocumentController,
  simulation: SimulationController,
  records: readonly ExperimentRecordedDataRecord[],
): MeasurementRecordRequest {
  const result = simulation.recordedData
  const schemas = experimentDocument.simulationProgram?.recordedData
  if (!result || !schemas || simulation.stale) throw new Error('저장 가능한 최신 RecordedData가 없습니다.')

  const recordsByName = new Map(records.map((record) => [record.name, record]))
  const saved: MeasurementRecordRequest['recorded_data'][number][] = []
  const persistNode = (spec: ResolvedDataSchemaNode, data: RecordedDataNode, path: string) => {
    if (isSchemaLeaf(spec)) {
      const tensor = data as RecordedDataTensor
      const record = recordsByName.get(path)
      if (!record) throw new Error(`저장된 ExperimentRecord를 찾을 수 없습니다: ${path}`)
      saved.push({
        experiment_record_id: record.id,
        data: persistDataTensor(spec, tensor, path),
      })
      return
    }
    const names = Object.keys(spec)
    const group = data as RecordedDataGroup
    names.forEach((name) => persistNode(spec[name], group[name], `${path}.${name}`))
  }
  const names = Object.keys(result)
  names.forEach((name) => persistNode(schemas[name], result[name], name))
  return { recorded_data: Object.freeze(saved) }
}

export function useCaeMeasurementActions({
  authenticated,
  calculationDataActions,
  experimentClean,
  experimentDocument,
  experimentId,
  experimentSourceHash,
  onGenerateCandidate,
  selection,
  simulation,
}: {
  authenticated: boolean
  calculationDataActions: CalculationDataActions
  experimentClean: boolean
  experimentDocument: CadDocumentController
  experimentId: number | null
  experimentSourceHash: string | null
  onGenerateCandidate: () => number | null
  selection: CaeDataSelection
  simulation: SimulationController
}) {
  const queryClient = useQueryClient()
  const queryScope = usePrivateQueryScope()
  const experimentRecordsQuery = useQuery({
    ...experimentRecordsQueryOptions(queryScope, experimentId),
    enabled: authenticated && experimentId !== null,
  })
  const cancelCalculationData = calculationDataActions.cancel
  const calculateMeasurementData = calculationDataActions.calculateMeasurement
  const [lifecycle, dispatchLifecycle] = useReducer(measurementLifecycleReducer, initialMeasurementLifecycleState)
  const {
    automaticCalculationData,
    busy,
    error,
    generateAndRunState,
    operation,
    pendingRecordMeasurementId,
    saveAndRunState,
    stage,
    status,
  } = selectMeasurementLifecycle(lifecycle)
  const selectedMeasurement = selection.measurement
  const clearSelectedMeasurement = selection.clearMeasurement
  const loadSelectedMeasurement = selection.loadMeasurement
  const activeMeasurementId = useRef<number | null>(null)
  const saveAndRunAttemptSequence = useRef(0)
  const activeSaveAndRunAttempt = useRef<number | null>(null)
  const saveAndRunCompletion = useRef<(SaveAndRunCompletionCallbacks & Readonly<{ attemptId: number }>) | null>(null)
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
    dispatchLifecycle({ type: 'fail', message })
    toast.error(message)
  }, [])

  const finishGenerateAndRun = useCallback(
    (sequence: number, summary?: Pick<GenerateAndRunState, 'failures' | 'repeat' | 'successes' | 'total'>) => {
      if (generateAndRunSequence.current !== sequence) return false
      generateAndRunSequence.current += 1
      generateAndRunStep.current = null
      generateAndRunCancelRequested.current = false
      activeMeasurementId.current = null
      dispatchLifecycle({ type: 'complete' })
      if (summary?.repeat) {
        const message = `Repeat Run ${summary.total.toLocaleString()}회 완료: 성공 ${summary.successes.toLocaleString()}회, 실패 ${summary.failures.toLocaleString()}회`
        if (summary.failures > 0) toast.warning(message)
        else toast.success(message)
      }
      return true
    },
    [],
  )

  const resolveSaveAndRun = useCallback((completion: SaveAndRunCompletion) => {
    const pending = saveAndRunCompletion.current
    if (!pending || pending.attemptId !== completion.attemptId) return false
    saveAndRunCompletion.current = null
    pending.resolve(completion)
    return true
  }, [])

  const rejectSaveAndRun = useCallback((attemptId: number, cause: unknown, fallback: string) => {
    const pending = saveAndRunCompletion.current
    if (!pending || pending.attemptId !== attemptId) return false
    saveAndRunCompletion.current = null
    pending.reject(
      cause instanceof Error
        ? cause
        : new Error(
            typeof cause === 'string' && cause.length > 0 ? cause : fallback || 'Save & Run이 완료되지 않았습니다.',
          ),
    )
    return true
  }, [])

  const finishSaveAndRun = useCallback((attemptId: number) => {
    if (activeSaveAndRunAttempt.current !== attemptId) return false
    activeSaveAndRunAttempt.current = null
    activeMeasurementId.current = null
    dispatchLifecycle({ type: 'complete' })
    return true
  }, [])

  useEffect(
    () => () => {
      const pending = saveAndRunCompletion.current
      saveAndRunCompletion.current = null
      activeSaveAndRunAttempt.current = null
      pending?.reject(new Error('Save & Run이 완료되기 전에 작업 화면이 종료되었습니다.'))
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
    dispatchLifecycle({
      type: 'progress',
      status: 'preparing',
      stage: generateAndRunStage(nextState, 'Candidate 생성'),
      generateAndRunState: nextState,
    })
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
    (measurementIds: readonly number[] = []) =>
      invalidateMeasurementMutation(queryClient, queryScope, experimentId, measurementIds),
    [experimentId, queryClient, queryScope],
  )

  const refreshPersistedMeasurement = useCallback(
    async (measurementId: number, selectedExperimentId: number | null) => {
      await invalidate([measurementId]).catch(() => undefined)
      try {
        const row = await loadSelectedMeasurement(measurementId, selectedExperimentId)
        if (!row) throw new Error('Measurement refresh was superseded.')
        return row
      } catch {
        clearSelectedMeasurement()
        toast.error(
          `Measurement #${measurementId}은 서버에 저장되었지만 화면을 새로 고치지 못했습니다. 목록에서 다시 선택하세요.`,
        )
        return null
      }
    },
    [clearSelectedMeasurement, invalidate, loadSelectedMeasurement],
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
    dispatchLifecycle({ type: 'start', operation: 'candidate', status: 'preparing', stage: 'Candidate 생성' })
    try {
      if (onGenerateCandidate() === null) throw new Error('Candidate 생성을 시작하지 못했습니다.')
    } catch (cause) {
      fail(cause, 'Candidate를 생성하지 못했습니다.')
    } finally {
      dispatchLifecycle({ type: 'complete' })
    }
  }, [experimentDocument.runIsBusy, fail, onGenerateCandidate, operation, pendingRecordMeasurementId])

  const startGenerateAndRun = useCallback(
    (total: number, repeat: boolean) => {
      if (operation || generateAndRunStep.current || pendingRecordMeasurementId || experimentDocument.runIsBusy) {
        return false
      }
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
        dispatchLifecycle({
          type: 'start',
          operation: 'generate-and-run',
          status: 'preparing',
          stage: generateAndRunStage(initialState, 'Candidate 생성'),
          generateAndRunState: initialState,
        })
        if (!startGenerateAndRunAttempt(initialState)) throw new Error('Candidate 생성을 시작하지 못했습니다.')
        return true
      } catch (cause) {
        generateAndRunSequence.current += 1
        generateAndRunStep.current = null
        fail(cause, repeat ? 'Repeat Run을 시작하지 못했습니다.' : 'Generate & Run을 시작하지 못했습니다.')
        dispatchLifecycle({ type: 'complete' })
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
    dispatchLifecycle({ type: 'start', operation: 'save', status: 'preparing', stage: 'Measurement 저장' })
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
      dispatchLifecycle({ type: 'complete' })
    }
  }, [fail, operation, pendingRecordMeasurementId, refreshPersistedMeasurement, requireSavableCandidate])

  const startSaveAndRun = useCallback(
    (completion?: SaveAndRunCompletionCallbacks) => {
      const unavailableReason =
        activeSaveAndRunAttempt.current !== null || operation
          ? '다른 Measurement 작업이 진행 중입니다.'
          : pendingRecordMeasurementId
            ? '실행 결과 저장을 다시 시도한 뒤 Save & Run을 시작하세요.'
            : experimentDocument.runIsBusy
              ? 'Experiment 평가가 완료된 뒤 Save & Run을 시작하세요.'
              : null
      if (unavailableReason) {
        completion?.reject(new Error(unavailableReason))
        return false
      }

      const attemptId = ++saveAndRunAttemptSequence.current
      activeSaveAndRunAttempt.current = attemptId
      if (completion) saveAndRunCompletion.current = { attemptId, ...completion }
      try {
        const request = requireSavableCandidate()
        const state: SaveAndRunState = {
          attemptId,
          baselineRevision: experimentDocument.revision,
          experimentId: request.experiment_id,
          measurementId: null,
          phase: 'saving',
          sourceHash: request.experiment_source_hash,
        }
        dispatchLifecycle({
          type: 'start',
          operation: 'save-and-run',
          status: 'preparing',
          stage: 'Current Candidate 저장',
          saveAndRunState: state,
        })
        void (async () => {
          try {
            const { id } = await dbTables.Measurement.create(request)
            if (activeSaveAndRunAttempt.current !== attemptId) return
            const identity = experimentIdentityRef.current
            if (
              !identity.experimentClean ||
              identity.experimentId !== state.experimentId ||
              identity.experimentSourceHash !== state.sourceHash
            ) {
              throw new Error(
                'Experiment가 변경되어 Save & Run을 중단했습니다. 저장된 Prepared Measurement는 유지됩니다.',
              )
            }
            const measurementState: SaveAndRunState = {
              ...state,
              baselineRevision: experimentDocumentRef.current.revision,
              measurementId: id,
              phase: 'measurement',
            }
            const row = await refreshPersistedMeasurement(id, state.experimentId)
            if (activeSaveAndRunAttempt.current !== attemptId) return
            if (!row) throw new Error(`Measurement #${id}은 저장되었지만 Save & Run을 계속할 수 없습니다.`)
            dispatchLifecycle({
              type: 'progress',
              status: 'preparing',
              stage: 'Measurement 평가',
              saveAndRunState: measurementState,
            })
          } catch (cause) {
            if (activeSaveAndRunAttempt.current !== attemptId) return
            rejectSaveAndRun(attemptId, cause, '현재 Candidate를 저장하지 못했습니다.')
            fail(cause, '현재 Candidate를 저장하지 못했습니다.')
            finishSaveAndRun(attemptId)
          }
        })()
        return true
      } catch (cause) {
        rejectSaveAndRun(attemptId, cause, 'Save & Run을 시작하지 못했습니다.')
        fail(cause, 'Save & Run을 시작하지 못했습니다.')
        finishSaveAndRun(attemptId)
        return false
      }
    },
    [
      experimentDocument.revision,
      experimentDocument.runIsBusy,
      fail,
      finishSaveAndRun,
      operation,
      pendingRecordMeasurementId,
      refreshPersistedMeasurement,
      rejectSaveAndRun,
      requireSavableCandidate,
    ],
  )
  const saveAndRunCurrent = useCallback(() => startSaveAndRun(), [startSaveAndRun])
  const saveAndRunCurrentAsync = useCallback(
    () =>
      new Promise<SaveAndRunCompletion>((resolve, reject) => {
        startSaveAndRun({ resolve, reject })
      }),
    [startSaveAndRun],
  )

  const deleteMeasurements = useCallback(
    async (rows: readonly SavedMeasurement[]) => {
      if (operation || pendingRecordMeasurementId) return false
      dispatchLifecycle({ type: 'start', operation: 'delete', status: 'preparing', stage: 'Measurement 삭제' })
      try {
        const ids = rows.map((row) => row.id)
        await dbTables.Measurement.deleteRows(ids)
        if (selectedMeasurement && ids.includes(selectedMeasurement.id)) clearSelectedMeasurement()
        await invalidate(ids).catch(() => undefined)
        toast.success(`Measurement ${ids.length.toLocaleString()}개를 삭제했습니다.`)
        return true
      } catch (cause) {
        fail(cause, 'Measurement를 삭제하지 못했습니다.')
        return false
      } finally {
        dispatchLifecycle({ type: 'complete' })
      }
    },
    [clearSelectedMeasurement, fail, invalidate, operation, pendingRecordMeasurementId, selectedMeasurement],
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
    if (generateAndRunState.phase === 'running') {
      if (automaticCalculationData) cancelCalculationData()
      else simulation.cancel()
    }
    if (finishGenerateAndRun(generateAndRunState.sequence)) {
      fail(
        new Error(
          'Experiment가 변경되어 Generate & Run을 중단했습니다. 이미 저장된 Prepared Measurement는 유지됩니다.',
        ),
        '',
      )
    }
  }, [
    automaticCalculationData,
    cancelCalculationData,
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
    if (!saveAndRunState) return
    if (
      experimentClean &&
      experimentId === saveAndRunState.experimentId &&
      experimentSourceHash === saveAndRunState.sourceHash
    ) {
      return
    }
    if (saveAndRunState.phase === 'running') {
      if (automaticCalculationData) cancelCalculationData()
      else simulation.cancel()
    }
    const cause = new Error(
      'Experiment가 변경되어 Save & Run을 중단했습니다. 저장된 Prepared Measurement는 유지됩니다.',
    )
    rejectSaveAndRun(saveAndRunState.attemptId, cause, '')
    fail(cause, '')
    finishSaveAndRun(saveAndRunState.attemptId)
  }, [
    automaticCalculationData,
    cancelCalculationData,
    experimentClean,
    experimentId,
    experimentSourceHash,
    fail,
    finishSaveAndRun,
    rejectSaveAndRun,
    saveAndRunState,
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
    dispatchLifecycle({
      type: 'progress',
      status: 'preparing',
      stage: generateAndRunStage(state, 'Measurement 저장'),
      generateAndRunState: { ...state, phase: 'saving' },
    })
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
        const row = await refreshPersistedMeasurement(id, state.experimentId)
        if (generateAndRunSequence.current !== state.sequence) return
        if (!row) {
          const message = `Measurement #${id}은 저장되었지만 Generate & Run을 계속할 수 없습니다.`
          dispatchLifecycle({ type: 'fail', message })
          advanceGenerateAndRun(measurementState, false)
          return
        }
        generateAndRunStep.current = 'measurement'
        dispatchLifecycle({
          type: 'progress',
          status: 'preparing',
          stage: generateAndRunStage(measurementState, 'Measurement 평가'),
          generateAndRunState: measurementState,
        })
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
    if (selectedMeasurement && selectedMeasurement.id !== state.measurementId) {
      fail(new Error('Generate & Run을 위해 저장한 Measurement 선택이 변경되었습니다.'), '')
      advanceGenerateAndRun(state, false)
      return
    }
    if (!selectedMeasurement || experimentDocument.revision <= state.baselineRevision) return
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
    dispatchLifecycle({
      type: 'progress',
      status: 'running',
      stage: generateAndRunStage(state, 'Simulation 실행'),
      generateAndRunState: { ...state, phase: 'running' },
    })
    pendingRecordRequest.current = null
    activeMeasurementId.current = state.measurementId
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
    selectedMeasurement,
    simulation,
  ])

  useEffect(() => {
    const state = saveAndRunState
    if (operation !== 'save-and-run' || !state || state.phase !== 'measurement' || !state.measurementId) {
      return
    }
    if (selectedMeasurement && selectedMeasurement.id !== state.measurementId) {
      const cause = new Error('Save & Run을 위해 저장한 Measurement 선택이 변경되었습니다.')
      rejectSaveAndRun(state.attemptId, cause, '')
      fail(cause, '')
      finishSaveAndRun(state.attemptId)
      return
    }
    if (!selectedMeasurement || experimentDocument.revision <= state.baselineRevision) return
    if (experimentDocument.status === 'Error') {
      const cause = new Error(experimentDocument.error?.message ?? '저장된 Measurement 평가에 실패했습니다.')
      rejectSaveAndRun(state.attemptId, cause, '저장된 Measurement 평가에 실패했습니다.')
      fail(cause, '저장된 Measurement 평가에 실패했습니다.')
      finishSaveAndRun(state.attemptId)
      return
    }
    if (
      experimentDocument.status !== 'Ready' ||
      experimentDocument.successfulRevision !== experimentDocument.revision
    ) {
      return
    }
    if (!simulation.canRun) {
      const cause = new Error('저장된 Measurement를 실행할 수 없습니다.')
      rejectSaveAndRun(state.attemptId, cause, '')
      fail(cause, '')
      finishSaveAndRun(state.attemptId)
      return
    }

    activeMeasurementId.current = state.measurementId
    dispatchLifecycle({
      type: 'progress',
      status: 'running',
      stage: 'Simulation 실행',
      saveAndRunState: { ...state, phase: 'running' },
    })
    pendingRecordRequest.current = null
    const runId = simulation.run()
    if (!runId) {
      activeMeasurementId.current = null
      const cause = new Error('Simulation을 시작하지 못했습니다.')
      rejectSaveAndRun(state.attemptId, cause, '')
      fail(cause, '')
      finishSaveAndRun(state.attemptId)
    }
  }, [
    experimentDocument.error?.message,
    experimentDocument.revision,
    experimentDocument.status,
    experimentDocument.successfulRevision,
    fail,
    finishSaveAndRun,
    operation,
    rejectSaveAndRun,
    saveAndRunState,
    selectedMeasurement,
    simulation,
  ])

  const runSelected = useCallback(() => {
    const measurement = selectedMeasurement
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
    pendingRecordRequest.current = null
    activeMeasurementId.current = measurement.id
    dispatchLifecycle({ type: 'start', operation: 'measurement', status: 'running', stage: 'Simulation 실행' })
    const runId = simulation.run()
    if (!runId) {
      activeMeasurementId.current = null
      fail(new Error('Simulation을 시작하지 못했습니다.'), '')
      dispatchLifecycle({ type: 'complete' })
    }
    return runId
  }, [experimentClean, experimentId, fail, operation, pendingRecordMeasurementId, selectedMeasurement, simulation])

  const persistRecordedData = useCallback(
    async (measurementId: number, request: MeasurementRecordRequest) => {
      let alreadyRecorded = false
      try {
        await dbTables.Measurement.record(measurementId, request)
      } catch (cause) {
        if ((cause as { status?: unknown })?.status !== 409) throw cause
        const row = await loadSelectedMeasurement(measurementId, experimentId).catch(() => null)
        if (!row?.recorded_at) throw cause
        dispatchLifecycle({ type: 'recordResolved' })
        pendingRecordRequest.current = null
        await invalidate([measurementId]).catch(() => undefined)
        toast.success(`Measurement #${measurementId}의 RecordedData는 이미 저장되어 있었습니다.`)
        alreadyRecorded = true
      }
      dispatchLifecycle({ type: 'recordResolved' })
      pendingRecordRequest.current = null
      if (await refreshPersistedMeasurement(measurementId, experimentId)) {
        if (!alreadyRecorded) toast.success(`Measurement #${measurementId}의 RecordedData를 저장했습니다.`)
      }
      dispatchLifecycle({ type: 'calculationStarted' })
      try {
        const summary = await calculateMeasurementData(measurementId, {
          onProgress: (progress) =>
            dispatchLifecycle({
              type: 'progress',
              stage: `${progress.stage} · ${progress.completed.toLocaleString()}/${progress.total.toLocaleString()}`,
            }),
        })
        if (summary.failed > 0) {
          const message = `Measurement #${measurementId} CalculationData 일부를 저장하지 못했습니다: 성공 ${summary.succeeded.toLocaleString()}개, 실패 ${summary.failed.toLocaleString()}개`
          dispatchLifecycle({ type: 'fail', message })
          toast.warning(message)
        }
        return summary
      } finally {
        dispatchLifecycle({ type: 'calculationFinished' })
      }
    },
    [calculateMeasurementData, experimentId, invalidate, loadSelectedMeasurement, refreshPersistedMeasurement],
  )

  const retryRecord = useCallback(async () => {
    const measurementId = pendingRecordMeasurementId
    const request = pendingRecordRequest.current
    if (!measurementId || !request || operation) return false
    dispatchLifecycle({ type: 'start', operation: 'record', status: 'recording', stage: 'RecordedData 다시 저장' })
    try {
      const summary = await persistRecordedData(measurementId, request)
      const succeeded = summary.failed === 0 && !summary.cancelled
      if (succeeded) dispatchLifecycle({ type: 'retrySucceeded' })
      return succeeded
    } catch (cause) {
      fail(cause, 'RecordedData를 다시 저장하지 못했습니다.')
      return false
    } finally {
      dispatchLifecycle({ type: 'complete' })
    }
  }, [fail, operation, pendingRecordMeasurementId, persistRecordedData])

  useEffect(() => {
    const batchState =
      operation === 'generate-and-run' && generateAndRunState?.phase === 'running' ? generateAndRunState : null
    const currentState = operation === 'save-and-run' && saveAndRunState?.phase === 'running' ? saveAndRunState : null
    if (operation !== 'measurement' && !batchState && !currentState) return
    if (currentState && activeSaveAndRunAttempt.current !== currentState.attemptId) return
    const measurementId = activeMeasurementId.current
    if (!measurementId) return
    if (simulation.process.status === 'preparing' || simulation.process.status === 'running') {
      const nextStage = batchState
        ? generateAndRunStage(batchState, simulation.process.stage ?? 'Simulation 실행')
        : (simulation.process.stage ?? 'Simulation 실행')
      if (status !== simulation.process.status || stage !== nextStage) {
        dispatchLifecycle({ type: 'progress', status: simulation.process.status, stage: nextStage })
      }
      return
    }
    if (simulation.process.status === 'succeeded') {
      activeMeasurementId.current = null
      dispatchLifecycle({
        type: 'progress',
        status: 'recording',
        stage: batchState ? generateAndRunStage(batchState, 'RecordedData 저장') : 'RecordedData 저장',
      })
      void (async () => {
        try {
          const records = experimentRecordsQuery.data?.items
          if (!records) throw new Error('ExperimentRecord 계약을 불러오지 못했습니다.')
          const request = recordRequest(experimentDocumentRef.current, simulationRef.current, records)
          pendingRecordRequest.current = request
          const summary = await persistRecordedData(measurementId, request)
          if (currentState && activeSaveAndRunAttempt.current !== currentState.attemptId) return
          if (batchState) {
            if (summary.cancelled) finishGenerateAndRun(batchState.sequence)
            else advanceGenerateAndRun(batchState, summary.failed === 0)
          }
          if (currentState) {
            if (summary.cancelled) {
              rejectSaveAndRun(currentState.attemptId, 'CalculationData 계산이 취소되었습니다.', '')
            } else {
              resolveSaveAndRun(
                Object.freeze({
                  attemptId: currentState.attemptId,
                  measurementId,
                  recordedDataSaved: true as const,
                  calculationSummary: summary,
                }),
              )
            }
            finishSaveAndRun(currentState.attemptId)
          }
        } catch (cause) {
          if (currentState && activeSaveAndRunAttempt.current !== currentState.attemptId) return
          if (pendingRecordRequest.current) dispatchLifecycle({ type: 'recordPending', measurementId })
          if (currentState) rejectSaveAndRun(currentState.attemptId, cause, 'RecordedData를 저장하지 못했습니다.')
          fail(cause, 'RecordedData를 저장하지 못했습니다.')
          if (batchState) finishGenerateAndRun(batchState.sequence)
          if (currentState) finishSaveAndRun(currentState.attemptId)
        } finally {
          if (!batchState && !currentState) {
            dispatchLifecycle({ type: 'complete' })
          }
        }
      })()
      return
    }
    if (simulation.process.status === 'failed' || simulation.process.status === 'cancelled') {
      activeMeasurementId.current = null
      const cause = simulation.process.error ?? 'Simulation이 완료되지 않았습니다.'
      if (currentState) rejectSaveAndRun(currentState.attemptId, cause, 'Simulation이 완료되지 않았습니다.')
      fail(cause, 'Simulation이 완료되지 않았습니다.')
      if (batchState) {
        if (generateAndRunCancelRequested.current) finishGenerateAndRun(batchState.sequence)
        else advanceGenerateAndRun(batchState, false)
      } else if (currentState) {
        finishSaveAndRun(currentState.attemptId)
      } else {
        dispatchLifecycle({ type: 'complete' })
      }
    }
  }, [
    advanceGenerateAndRun,
    fail,
    finishGenerateAndRun,
    finishSaveAndRun,
    generateAndRunState,
    experimentRecordsQuery.data?.items,
    operation,
    persistRecordedData,
    rejectSaveAndRun,
    resolveSaveAndRun,
    saveAndRunState,
    simulation.process.error,
    simulation.process.stage,
    simulation.process.status,
    stage,
    status,
  ])

  const cancel = useCallback(() => {
    if (operation === 'save-and-run' && saveAndRunState) {
      dispatchLifecycle({ type: 'cancel' })
      if (saveAndRunState.phase === 'running') {
        if (automaticCalculationData) cancelCalculationData()
        else simulation.cancel()
      }
      const cause = new Error(
        saveAndRunState.measurementId
          ? `Save & Run을 취소했습니다. Prepared Measurement #${saveAndRunState.measurementId}은 유지됩니다.`
          : 'Save & Run을 취소했습니다. 이미 전송된 Prepared Measurement 저장 요청은 완료될 수 있습니다.',
      )
      rejectSaveAndRun(saveAndRunState.attemptId, cause, '')
      finishSaveAndRun(saveAndRunState.attemptId)
      return
    }
    if (
      operation !== 'measurement' &&
      !(operation === 'generate-and-run' && generateAndRunState?.phase === 'running') &&
      !automaticCalculationData
    ) {
      return
    }
    if (operation === 'generate-and-run') generateAndRunCancelRequested.current = true
    dispatchLifecycle({ type: 'cancel' })
    if (automaticCalculationData) cancelCalculationData()
    else simulation.cancel()
  }, [
    automaticCalculationData,
    cancelCalculationData,
    finishSaveAndRun,
    generateAndRunState?.phase,
    operation,
    rejectSaveAndRun,
    saveAndRunState,
    simulation,
  ])

  const cancelable =
    (automaticCalculationData ||
      operation === 'measurement' ||
      (operation === 'generate-and-run' && generateAndRunState?.phase === 'running') ||
      operation === 'save-and-run') &&
    (operation === 'save-and-run' ||
      automaticCalculationData ||
      ['preparing', 'running'].includes(simulation.process.status))

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
    automaticCalculationData,
    busy,
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
    saveAndRunCurrent,
    saveAndRunCurrentAsync,
    saveCurrent,
    stage,
  }
}
