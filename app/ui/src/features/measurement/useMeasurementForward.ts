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

type ForwardSession = { runtime: PredictionRuntimeController; model: PredictionForwardModelBundle; dataKey: string }

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
  const [output, setOutput] = useState<{ key: string; data: RecordedData } | null>(null)
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

  const build = useCallback(async () => {
    if (!experimentId || !document.varsSchema || !document.simulationProgram || !ready || pending.current) return
    const runtime = new PredictionRuntimeController()
    runtime.start()
    pending.current = runtime
    const expected = generation.current
    setBuilding(true)
    setError('')
    try {
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
      const model = await buildForwardModel({
        context: {
          experimentId,
          measurements: rows.items.filter((row) => row.recorded_at),
          experimentRecords: records.items,
          fingerprint: JSON.stringify([contextKey, rows.items.map((row) => [row.id, row.updated_at, row.recorded_at])]),
        },
        experimentId,
        requiredRecordIds: records.items.map((record) => record.id),
        varsSchema: document.varsSchema,
        runtime,
        transaction,
        recordedData: document.simulationProgram.recordedData,
        resultContracts: document.simulationProgram.resultContracts,
        setup: defaultPredictionSetup,
        onActivity,
        onForwardRecordProfilesChange: () => {},
        onProfile: () => {},
      })
      if (generation.current !== expected || pending.current !== runtime) return
      const next = {
        runtime,
        model,
        dataKey: JSON.stringify(rows.items.map((row) => [row.id, row.updated_at, row.recorded_at])),
      }
      sessionRef.current?.runtime.dispose()
      sessionRef.current = next
      setSession(next)
      setOutput(null)
      pending.current = null
    } catch (cause) {
      if (generation.current === expected) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (pending.current === runtime) {
        pending.current = null
        runtime.dispose()
      }
      if (generation.current === expected) setBuilding(false)
    }
  }, [contextKey, document.simulationProgram, document.varsSchema, experimentId, onActivity, ready])

  useEffect(() => {
    if (
      !active ||
      !session ||
      !ready ||
      !vars ||
      !document.varsSchema ||
      !document.simulationProgram?.boxGrids ||
      output?.key === key
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
            setOutput({ key, data: recorded })
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
  }, [active, session, ready, vars, document.varsSchema, document.simulationProgram, key, onActivity, output?.key])
  return {
    build,
    building,
    predicting,
    error,
    model: session?.model ?? null,
    outdated: Boolean(session && session.dataKey !== dataKey),
    data: ready && output?.key === key ? output.data : undefined,
  }
}
