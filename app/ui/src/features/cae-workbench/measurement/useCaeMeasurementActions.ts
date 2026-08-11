import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { dbTables, type MeasurementSaveRequest } from '@/api'
import { createSampleRecord, createSetupRecord } from '@/features/viewer/persistence/contracts'
import type { CadDocumentController, SimulationController } from '@/features/viewer/workspace/useCadWorkspace'
import { createDataTensorAccessor, MAX_RECORDED_DATA_BYTES, persistDataSchema, persistDataTensor } from '@/lib/cad'
import type { CaeDataSelection } from './useCaeDataSelection'
import type { SavedSample, SavedSetup } from '../types'

type RealizationState = Readonly<{
  kind: 'sample' | 'setup'
  minimumRevision: number
  stage: 'evaluate' | 'saving'
}>

type GenerateMeasurementState = Readonly<{
  minimumExperimentRevision: number
  minimumStructureRevision: number
  stage: 'evaluate' | 'saving'
}>

type MeasurementRunState = Readonly<{
  mode: 'generated' | 'perform'
  overwrite: boolean
  sampleId: number
  setupId: number
  minimumExperimentRevision: number
  minimumStructureRevision: number
  stage: 'evaluate' | 'running' | 'saving'
  startedAt: number | null
}>

function readyAt(document: CadDocumentController, minimumRevision: number) {
  return (
    document.revision >= minimumRevision &&
    document.status === 'Ready' &&
    document.successfulRevision === document.revision
  )
}

function measurementRequest(
  sampleId: number,
  setupId: number,
  experimentDocument: CadDocumentController,
  simulation: SimulationController,
  overwrite: boolean,
): MeasurementSaveRequest {
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
  return { sample_id: sampleId, setup_id: setupId, overwrite, recorded_data: recordedData }
}

export function useCaeMeasurementActions({
  authenticated,
  experimentDocument,
  experimentClean,
  experimentId,
  pairClean,
  selection,
  simulation,
  structureDocument,
  structureClean,
  structureId,
}: {
  authenticated: boolean
  experimentDocument: CadDocumentController
  experimentClean: boolean
  experimentId: number | null
  pairClean: boolean
  selection: CaeDataSelection
  simulation: SimulationController
  structureDocument: CadDocumentController
  structureClean: boolean
  structureId: number | null
}) {
  const queryClient = useQueryClient()
  const [realization, setRealization] = useState<RealizationState | null>(null)
  const [generation, setGeneration] = useState<GenerateMeasurementState | null>(null)
  const [run, setRun] = useState<MeasurementRunState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operationSequence = useRef(0)

  const fail = useCallback((message: string) => {
    setError(message)
    toast.error(message)
  }, [])

  const requireCleanPair = useCallback(() => {
    if (!authenticated) throw new Error('로그인이 필요합니다.')
    if (!pairClean || !structureId || !experimentId) {
      throw new Error('Structure와 Experiment를 먼저 저장한 뒤 실행하세요.')
    }
  }, [authenticated, experimentId, pairClean, structureId])

  const requireCleanDefinition = useCallback(
    (kind: 'sample' | 'setup') => {
      if (!authenticated) throw new Error('로그인이 필요합니다.')
      if (kind === 'sample' ? !structureClean || !structureId : !experimentClean || !experimentId) {
        throw new Error(`${kind === 'sample' ? 'Structure' : 'Experiment'}를 먼저 저장한 뒤 실행하세요.`)
      }
    },
    [authenticated, experimentClean, experimentId, structureClean, structureId],
  )

  const startRealization = useCallback(
    (kind: 'sample' | 'setup') => {
      try {
        requireCleanDefinition(kind)
        if (realization || generation || run) return
        setError(null)
        const document = kind === 'sample' ? structureDocument : experimentDocument
        if (document.runIsBusy) throw new Error('현재 source 평가가 끝난 뒤 다시 실행하세요.')
        if (kind === 'sample') selection.clearSample()
        else selection.clearSetup()
        setRealization({ kind, minimumRevision: document.revision + 1, stage: 'evaluate' })
        document.handleReroll()
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [experimentDocument, fail, generation, realization, requireCleanDefinition, run, selection, structureDocument],
  )

  const startGenerateMeasurement = useCallback(() => {
    try {
      requireCleanPair()
      if (realization || generation || run) return
      if (structureDocument.runIsBusy || experimentDocument.runIsBusy) {
        throw new Error('Structure와 Experiment source 평가가 끝난 뒤 다시 실행하세요.')
      }
      setError(null)
      selection.clearAll()
      setGeneration({
        minimumExperimentRevision: experimentDocument.revision + 1,
        minimumStructureRevision: structureDocument.revision + 1,
        stage: 'evaluate',
      })
      structureDocument.handleReroll()
      experimentDocument.handleReroll()
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause))
    }
  }, [experimentDocument, fail, generation, realization, requireCleanPair, run, selection, structureDocument])

  const startPerformMeasurement = useCallback(
    (
      overwrite = false,
      expected?: Readonly<{
        sampleId: number
        setupId: number
      }>,
    ) => {
      try {
        requireCleanPair()
        if (realization || generation || run) return
        if (!selection.sample || !selection.setup) throw new Error('Sample과 Setup을 선택하세요.')
        if (expected && (selection.sample.id !== expected.sampleId || selection.setup.id !== expected.setupId)) {
          throw new Error('Sample 또는 Setup 선택이 바뀌었습니다. 다시 확인한 뒤 실행하세요.')
        }
        setError(null)
        setRun({
          mode: 'perform',
          overwrite,
          sampleId: selection.sample.id,
          setupId: selection.setup.id,
          minimumExperimentRevision: experimentDocument.revision,
          minimumStructureRevision: structureDocument.revision,
          stage: 'evaluate',
          startedAt: null,
        })
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [
      experimentDocument.revision,
      fail,
      generation,
      realization,
      requireCleanPair,
      run,
      selection,
      structureDocument.revision,
    ],
  )

  useEffect(() => {
    if (!realization || realization.stage !== 'evaluate') return
    const document = realization.kind === 'sample' ? structureDocument : experimentDocument
    if (document.status === 'Error') {
      setRealization(null)
      fail(`${realization.kind === 'sample' ? 'Sample' : 'Setup'} 생성 평가에 실패했습니다.`)
      return
    }
    if (!readyAt(document, realization.minimumRevision)) return
    const sequence = ++operationSequence.current
    setRealization({ ...realization, stage: 'saving' })
    void (async () => {
      if (realization.kind === 'sample') {
        if (!structureId || !structureDocument.variables || !structureDocument.materialParameters) {
          throw new Error('Ready 상태의 Structure 실현값이 필요합니다.')
        }
        const record = createSampleRecord(
          structureId,
          structureDocument.variables,
          structureDocument.materialParameters as never,
        )
        const [saved] = await dbTables.Sample.upsertRow([record])
        const row = { ...record, id: saved.id, updated_at: new Date().toISOString() } as SavedSample
        selection.setGeneratedSample(row)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cae', 'samples', structureId] }),
          queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'sample'] }),
        ])
      } else {
        if (!experimentId || !experimentDocument.variables || !experimentDocument.materialParameters) {
          throw new Error('Ready 상태의 Experiment 실현값이 필요합니다.')
        }
        const record = createSetupRecord(
          experimentId,
          experimentDocument.variables,
          experimentDocument.materialParameters as never,
        )
        const [saved] = await dbTables.Setup.upsertRow([record])
        const row = { ...record, id: saved.id, updated_at: new Date().toISOString() } as SavedSetup
        selection.setGeneratedSetup(row)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cae', 'setups', experimentId] }),
          queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'setup'] }),
        ])
      }
      if (sequence !== operationSequence.current) return
      setRealization(null)
      toast.success(`${realization.kind === 'sample' ? 'Sample' : 'Setup'}을 생성했습니다.`)
    })().catch((cause: unknown) => {
      if (sequence !== operationSequence.current) return
      setRealization(null)
      fail(cause instanceof Error ? cause.message : '실현값을 저장하지 못했습니다.')
    })
  }, [experimentDocument, experimentId, fail, queryClient, realization, selection, structureDocument, structureId])

  useEffect(() => {
    if (!generation || generation.stage !== 'evaluate') return
    if (structureDocument.status === 'Error' || experimentDocument.status === 'Error') {
      setGeneration(null)
      fail('Sample 또는 Setup 생성 평가에 실패했습니다.')
      return
    }
    if (
      !readyAt(structureDocument, generation.minimumStructureRevision) ||
      !readyAt(experimentDocument, generation.minimumExperimentRevision)
    )
      return
    if (
      !structureId ||
      !experimentId ||
      !structureDocument.variables ||
      !experimentDocument.variables ||
      !structureDocument.materialParameters ||
      !experimentDocument.materialParameters
    ) {
      setGeneration(null)
      fail('저장 가능한 Sample과 Setup 실현값이 없습니다.')
      return
    }

    const sequence = ++operationSequence.current
    setGeneration({ ...generation, stage: 'saving' })
    void (async () => {
      const sampleRecord = createSampleRecord(
        structureId,
        structureDocument.variables!,
        structureDocument.materialParameters as never,
      )
      const [savedSample] = await dbTables.Sample.upsertRow([sampleRecord])
      const sample = { ...sampleRecord, id: savedSample.id, updated_at: new Date().toISOString() } as SavedSample
      selection.setGeneratedSample(sample)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cae', 'samples', structureId] }),
        queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'sample'] }),
      ])

      const setupRecord = createSetupRecord(
        experimentId,
        experimentDocument.variables!,
        experimentDocument.materialParameters as never,
      )
      const [savedSetup] = await dbTables.Setup.upsertRow([setupRecord])
      const setup = { ...setupRecord, id: savedSetup.id, updated_at: new Date().toISOString() } as SavedSetup
      selection.setGeneratedSetup(setup)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['cae', 'setups', experimentId] }),
        queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'setup'] }),
      ])
      if (sequence !== operationSequence.current) return
      setGeneration(null)
      setRun({
        mode: 'generated',
        overwrite: false,
        sampleId: sample.id,
        setupId: setup.id,
        minimumExperimentRevision: experimentDocument.revision + 1,
        minimumStructureRevision: structureDocument.revision + 1,
        stage: 'evaluate',
        startedAt: null,
      })
    })().catch((cause: unknown) => {
      if (sequence !== operationSequence.current) return
      setGeneration(null)
      fail(cause instanceof Error ? cause.message : 'Sample과 Setup을 저장하지 못했습니다.')
    })
  }, [experimentDocument, experimentId, fail, generation, queryClient, selection, structureDocument, structureId])

  useEffect(() => {
    if (!run || run.stage !== 'evaluate') return
    if (structureDocument.status === 'Error' || experimentDocument.status === 'Error') {
      setRun(null)
      fail('선택한 Sample 또는 Setup 평가에 실패했습니다.')
      return
    }
    if (
      !readyAt(structureDocument, run.minimumStructureRevision) ||
      !readyAt(experimentDocument, run.minimumExperimentRevision)
    )
      return
    if (!simulation.canRun) return
    const startedAt = Date.now()
    if (!simulation.run()) {
      setRun(null)
      fail('CAE 실행을 시작하지 못했습니다.')
      return
    }
    setRun({ ...run, stage: 'running', startedAt })
  }, [experimentDocument, fail, run, simulation, structureDocument])

  useEffect(() => {
    if (!run || run.stage !== 'running' || run.startedAt === null) return
    if (simulation.process.startedAt !== null && simulation.process.startedAt < run.startedAt - 10) return
    if (simulation.process.status === 'failed' || simulation.process.status === 'cancelled') {
      setRun(null)
      fail(simulation.process.error ?? 'CAE 실행을 완료하지 못했습니다.')
      return
    }
    if (simulation.process.status !== 'succeeded' || !simulation.recordedData || simulation.stale) return

    let request: MeasurementSaveRequest
    try {
      request = measurementRequest(run.sampleId, run.setupId, experimentDocument, simulation, run.overwrite)
    } catch (cause) {
      setRun(null)
      fail(cause instanceof Error ? cause.message : String(cause))
      return
    }
    const sequence = ++operationSequence.current
    setRun({ ...run, stage: 'saving' })
    void dbTables.Measurement.save(request)
      .then(async ({ id }) => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['cae', 'measurements', structureId, experimentId] }),
          queryClient.invalidateQueries({ queryKey: ['analysis', structureId, experimentId] }),
          queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurements'] }),
          queryClient.invalidateQueries({ queryKey: ['cae-workbench', 'measurement-pairs'] }),
        ])
        await selection.loadMeasurement(id, structureId && experimentId ? { structureId, experimentId } : null)
        if (sequence !== operationSequence.current) return
        setRun(null)
        toast.success(
          run.mode === 'generated'
            ? 'Sample, Setup, Measurement와 RecordedData를 생성했습니다.'
            : 'Measurement와 RecordedData를 저장했습니다.',
        )
      })
      .catch((cause: unknown) => {
        if (sequence !== operationSequence.current) return
        setRun(null)
        fail(cause instanceof Error ? cause.message : 'Measurement를 저장하지 못했습니다.')
      })
  }, [experimentDocument, experimentId, fail, queryClient, run, selection, simulation, structureId])

  const cancelable =
    realization?.stage === 'evaluate' ||
    generation?.stage === 'evaluate' ||
    run?.stage === 'evaluate' ||
    run?.stage === 'running'

  const cancel = useCallback(() => {
    if (!cancelable) return
    operationSequence.current += 1
    if (run?.stage === 'running') simulation.cancel()
    setRealization(null)
    setGeneration(null)
    setRun(null)
    toast.info('현재 CAE 작업을 취소했습니다.')
  }, [cancelable, run?.stage, simulation])

  const busy = realization !== null || generation !== null || run !== null
  const operation = realization?.kind ?? (generation || run ? 'measurement' : null)
  const stage = realization
    ? realization.stage === 'saving'
      ? `${realization.kind === 'sample' ? 'Sample' : 'Setup'} 저장 중`
      : `${realization.kind === 'sample' ? 'Structure' : 'Experiment'} 평가 중`
    : generation
      ? generation.stage === 'saving'
        ? 'Sample과 Setup 저장 중'
        : 'Structure와 Experiment 실현 중'
      : run
        ? run.stage === 'evaluate'
          ? '선택 실현값 평가 중'
          : run.stage === 'running'
            ? (simulation.process.stage ?? 'CAE 실행 중')
            : 'Measurement 저장 중'
        : null

  return {
    busy,
    cancelable,
    error,
    operation,
    stage,
    cancel,
    clearError: () => setError(null),
    generateMeasurement: startGenerateMeasurement,
    generateSample: () => startRealization('sample'),
    generateSetup: () => startRealization('setup'),
    performMeasurement: startPerformMeasurement,
  }
}

export type CaeMeasurementActions = ReturnType<typeof useCaeMeasurementActions>
