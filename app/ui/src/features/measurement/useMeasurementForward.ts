import { useCallback, useEffect, useRef, useState } from 'react'
import { dbTables, getListRequest } from '@/api'
import type { RecordedData, Vars } from '@/lib/cad/model'
import type { CadDocumentController } from '@/features/viewer/workspace/useCadWorkspace'
import type { SavedMeasurement } from '@/features/cae-workbench/types'
import { buildForwardModel, predictForwardRecorded } from '@/features/prediction/forwardModel'
import { defaultPredictionSetup } from '@/features/prediction/usePredictionModels'
import {
  PredictionRuntimeController,
  type PredictionForwardModelBundle,
} from '@/features/prediction/usePredictionController'
import { PredictionWorkerRestartError } from '@/features/prediction/client'
import { varsFingerprint } from '@/lib/cad/model/vars'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'

type ForwardSession = {
  runtime: PredictionRuntimeController
  model: PredictionForwardModelBundle
  dataKey: string
  generation: number
}

export type MeasurementForwardPreparation = { session: ForwardSession | null; error: string }

export function useMeasurementForward({
  experimentId,
  contextKey,
  document,
  measurements,
  vars,
  ready,
  active,
  onActivity,
}: {
  experimentId: number | null
  contextKey: string
  document: CadDocumentController
  measurements: readonly SavedMeasurement[]
  vars: Readonly<Vars> | null
  ready: boolean
  active: boolean
  onActivity?: RuntimeActivityCallback
}) {
  const [session, setSession] = useState<ForwardSession | null>(null)
  const sessionRef = useRef<ForwardSession | null>(null)
  const pending = useRef<PredictionRuntimeController | null>(null)
  const [building, setBuilding] = useState(false)
  const [predicting, setPredicting] = useState(false)
  const [error, setError] = useState('')
  const [output, setOutput] = useState<{ key: string; session: ForwardSession; data: RecordedData } | null>(null)
  const key = varsFingerprint(vars)
  const dataKey = JSON.stringify(measurements.map((row) => [row.id, row.updated_at, row.recorded_at]))
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    sessionRef.current?.runtime.dispose()
    sessionRef.current = null
    pending.current?.dispose()
    pending.current = null
    setSession(null)
    setOutput(null)
    setError('')
    setBuilding(false)
    setPredicting(false)
    return () => {
      generation.current += 1
      sessionRef.current?.runtime.dispose()
      pending.current?.dispose()
    }
  }, [contextKey])

  const prepare = useCallback(
    async (candidate: CadDocumentController, abortSignal?: AbortSignal): Promise<MeasurementForwardPreparation> => {
      abortSignal?.throwIfAborted()
      if (!experimentId || !candidate.varsSchema || !candidate.simulationProgram)
        return { session: null, error: 'Forward 학습에 필요한 Experiment가 준비되지 않았습니다.' }
      pending.current?.dispose()
      const runtime = new PredictionRuntimeController()
      pending.current = runtime
      const expected = generation.current
      setBuilding(true)
      setError('')
      const abort = () => runtime.dispose()
      abortSignal?.addEventListener('abort', abort, { once: true })
      try {
        runtime.start()
        const transaction = runtime.beginTransaction()
        const signal = runtime.transactionSignal()
        const [records, rows] = await Promise.all([
          dbTables.ExperimentRecord.listRows(
            {
              ...getListRequest('visible'),
              experiment_id: experimentId,
              filter: { experiment_id: [experimentId, experimentId] },
              limit: null,
              sort: ['name', 'asc'],
            },
            { signal },
          ),
          dbTables.Measurement.listRows(
            {
              ...getListRequest('visible'),
              filter: { experiment_id: [experimentId, experimentId] },
              limit: null,
              sort: ['id', 'asc'],
            },
            { signal, resolveObjects: false },
          ),
        ])
        abortSignal?.throwIfAborted()
        if (generation.current !== expected || pending.current !== runtime)
          throw new DOMException('Stale Forward preparation', 'AbortError')
        if (!rows.items.some((row) => row.recorded_at))
          return { session: null, error: '학습할 실제 결과가 없습니다. CAD만 표시합니다.' }
        const model = await buildForwardModel({
          context: {
            experimentId,
            measurements: rows.items.filter((row) => row.recorded_at),
            experimentRecords: records.items,
            fingerprint: JSON.stringify([
              contextKey,
              rows.items.map((row) => [row.id, row.updated_at, row.recorded_at]),
            ]),
          },
          experimentId,
          requiredRecordIds: records.items.map((record) => record.id),
          varsSchema: candidate.varsSchema,
          runtime,
          transaction,
          recordedData: candidate.simulationProgram.recordedData,
          resultContracts: candidate.simulationProgram.resultContracts,
          setup: defaultPredictionSetup,
          onActivity,
          onForwardRecordProfilesChange: () => {},
          onProfile: () => {},
        })
        abortSignal?.throwIfAborted()
        if (generation.current !== expected || pending.current !== runtime)
          throw new DOMException('Stale Forward preparation', 'AbortError')
        const next = {
          runtime,
          model,
          dataKey: JSON.stringify(rows.items.map((row) => [row.id, row.updated_at, row.recorded_at])),
          generation: expected,
        }
        sessionRef.current?.runtime.dispose()
        sessionRef.current = next
        setSession(next)
        setOutput(null)
        pending.current = null
        return { session: next, error: '' }
      } catch (cause) {
        if (
          abortSignal?.aborted ||
          generation.current !== expected ||
          (cause as { name?: string })?.name === 'AbortError'
        )
          throw cause
        const message = cause instanceof Error ? cause.message : String(cause)
        if (pending.current === runtime) setError(message)
        return { session: null, error: message }
      } finally {
        abortSignal?.removeEventListener('abort', abort)
        if (pending.current === runtime) {
          pending.current = null
          runtime.dispose()
          if (generation.current === expected) setBuilding(false)
        }
        if (sessionRef.current?.runtime === runtime) setBuilding(false)
      }
    },
    [contextKey, experimentId, onActivity],
  )

  const build = useCallback(async () => {
    if (!ready || pending.current) return
    try {
      const result = await prepare(document)
      setError(result.error)
    } catch (cause) {
      if ((cause as { name?: string })?.name !== 'AbortError') throw cause
    }
  }, [document, prepare, ready])

  const predict = useCallback(
    async (
      prepared: MeasurementForwardPreparation,
      candidate: CadDocumentController,
      candidateVars: Readonly<Vars>,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted()
      const target = prepared.session
      if (!target) return { data: undefined, rules: undefined, error: prepared.error }
      const expected = generation.current
      const abort = () => {
        target.runtime.dispose()
        if (sessionRef.current === target) {
          sessionRef.current = null
          setSession(null)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      setPredicting(true)
      try {
        if (target !== sessionRef.current || target.generation !== expected)
          throw new DOMException('Stale Forward model', 'AbortError')
        const { recorded } = await predictForwardRecorded({
          model: target.model,
          runtime: target.runtime,
          transaction: target.runtime.beginTransaction(),
          vars: candidateVars,
          varsSchema: candidate.varsSchema!,
          candidateBoxGrids: candidate.simulationProgram!.boxGrids!,
          onActivity,
        })
        signal.throwIfAborted()
        if (generation.current !== expected || target !== sessionRef.current)
          throw new DOMException('Stale Forward prediction', 'AbortError')
        return { data: recorded, rules: target.model.rules, error: '' }
      } catch (cause) {
        if (signal.aborted || generation.current !== expected || (cause as { name?: string })?.name === 'AbortError')
          throw cause
        return { data: undefined, rules: undefined, error: cause instanceof Error ? cause.message : String(cause) }
      } finally {
        signal.removeEventListener('abort', abort)
        if (generation.current === expected) setPredicting(false)
      }
    },
    [onActivity],
  )

  useEffect(() => {
    if (
      !active ||
      !session ||
      !ready ||
      !vars ||
      !document.varsSchema ||
      !document.simulationProgram?.boxGrids ||
      (output?.key === key && output.session === session)
    )
      return
    let current = true
    const timer = window.setTimeout(() => {
      setPredicting(true)
      const transaction = session.runtime.beginTransaction()
      void predictForwardRecorded({
        model: session.model,
        runtime: session.runtime,
        transaction,
        vars,
        varsSchema: document.varsSchema!,
        candidateBoxGrids: document.simulationProgram!.boxGrids!,
        onActivity,
      })
        .then(({ recorded }) => {
          if (current) {
            setOutput({ key, session, data: recorded })
            setError('')
          }
        })
        .catch((cause: unknown) => {
          if (!current) return
          setOutput(null)
          setError(cause instanceof Error ? cause.message : String(cause))
          if (
            cause instanceof PredictionWorkerRestartError ||
            session.model.models.some((model) => model.workerEpoch !== session.runtime.workerEpoch)
          ) {
            session.runtime.dispose()
            sessionRef.current = null
            setSession(null)
          }
        })
        .finally(() => {
          if (current) setPredicting(false)
        })
    }, 180)
    return () => {
      current = false
      clearTimeout(timer)
      session.runtime.invalidateTransaction()
      setPredicting(false)
    }
  }, [active, session, ready, vars, document.varsSchema, document.simulationProgram, key, onActivity, output])
  return {
    build,
    prepare,
    predict,
    building,
    predicting,
    error,
    model: session?.model ?? null,
    outdated: Boolean(session && session.dataKey !== dataKey),
    data: ready && output?.key === key && output.session === session ? output.data : undefined,
  }
}
