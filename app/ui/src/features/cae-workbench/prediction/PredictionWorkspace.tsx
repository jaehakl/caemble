import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  dbTables,
  getListRequest,
  type CalculationDataAnalysisResponse,
  type CalculationDataOutput,
  type CalculationDataRecord,
  type CalculationRecord,
  type MeasurementRecord,
} from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { calculationSourceHash, runCalculation } from '@/lib/calculation'
import type { Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
import type { CaeWorkbenchState } from '../state/useCaeWorkbenchState'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { varsTensorFromFlat } from '../calculation/varsTensor'
import { recordedDataRules } from '../measurement/recordedData'
import { PredictionWorkerClient, PredictionWorkerRestartError } from './client'
import {
  calculationOutputSample,
  forwardTrainingRow,
  inverseTrainingRows,
  predictedRecordedData,
  predictionFingerprint,
  predictionRecordedSamples,
  predictionRecordedSamplesMatchRules,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import {
  comparePredictionOutput,
  inverseValidationAggregateErrorFromScales,
  predictionOutputRange,
  type PredictionValidationMetric,
} from './metrics'
import {
  PredictionCalculationPane,
  PredictionDetailsDialog,
  PredictionSetupDialog,
  PredictionVarsPane,
  type PredictionCalculationPaneItem,
  type PredictionKMode,
  type PredictionSetupBusyAction,
} from './PredictionPanels'
import { PREDICTION_NUMERIC_CELL_LIMIT } from './knn'
import type {
  PredictionCohortSummary,
  PredictionDirection,
  PredictionNeighbor,
  PredictionResult,
  PredictionTensorLayout,
  PredictionTrainingRow,
  PredictionWeighting,
} from './knn'
import type { PredictionWorkerModelProfile } from './protocol'

type SavedCalculation = CalculationRecord & Readonly<{ id: number }>
type SavedMeasurement = MeasurementRecord & Readonly<{ id: number }>
type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export type PredictionWorkspaceCommand = Readonly<{
  id: number
  type: 'settings' | 'details' | 'validate' | 'cancel'
}>

export type PredictionWorkspaceChromeState = Readonly<{
  busy: boolean
  canValidate: boolean
  direction: PredictionDirection
  status: string
  validateDisabledReason?: string
}>

type PredictionSetup = Readonly<{
  calculationIds: readonly number[]
  calculationWeights: Readonly<Record<number, number>>
  kMode: PredictionKMode
  manualK: number
  weighting: PredictionWeighting
}>

type PredictionContext = Readonly<{
  analysis: CalculationDataAnalysisResponse
  calculations: readonly SavedCalculation[]
  experimentId: number
  fingerprint: string
  measurements: readonly SavedMeasurement[]
}>

type ModelCache = Readonly<{
  fingerprint: string
  generation: number
  profile: PredictionWorkerModelProfile
  workerEpoch: number
}>

type ValidationRow = Readonly<{
  actual: CalculationDataOutput | null
  calculationId: number
  metric: PredictionValidationMetric | null
  error: string | null
  reference: CalculationDataOutput
}>

type ValidationResult = Readonly<{
  aggregateError: number | null
  candidateVarsFingerprint: string
  calculationWeights: Readonly<Record<number, number>>
  direction: PredictionDirection
  experimentId: number
  inverseInputLayouts: readonly PredictionTensorLayout[] | null
  inverseInputScales: Float64Array | null
  measurementId: number
  referenceRevision: number
  repredicted: Readonly<Record<number, CalculationDataOutput>>
  rows: readonly ValidationRow[]
  snapshotFingerprint: string
  sourceFingerprints: Readonly<Record<number, string>>
  setupFingerprint: string
  summary: string
  transactionId: number
}>

const defaultSetup: PredictionSetup = Object.freeze({
  calculationIds: Object.freeze([]),
  calculationWeights: Object.freeze({}),
  kMode: 'auto',
  manualK: 1,
  weighting: 'distance',
})

const integerRanges: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  int8: [-128, 127],
  int16: [-32_768, 32_767],
  int32: [-2_147_483_648, 2_147_483_647],
  uint8: [0, 255],
  uint16: [0, 65_535],
  uint32: [0, 4_294_967_295],
})

function candidateFingerprint(vars: Readonly<Vars> | null) {
  return vars ? JSON.stringify(vars) : 'none'
}

async function rowsInBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  for (let offset = 0; offset < items.length; offset += size) {
    await Promise.all(items.slice(offset, offset + size).map(run))
  }
}

function assertTrainingCellLimit(rows: readonly PredictionTrainingRow[]) {
  let cells = 0
  rows.forEach((row) => (cells += trainingRowCellCount(row)))
  if (!Number.isSafeInteger(cells) || cells > PREDICTION_NUMERIC_CELL_LIMIT) {
    throw new Error(
      `Prediction training data contains ${cells.toLocaleString()} numeric cells; the limit is ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()}.`,
    )
  }
}

function trainingRowCellCount(row: PredictionTrainingRow) {
  let cells = 0
  row.inputs.forEach((sample) => (cells += sample.values.length))
  row.outputs.forEach((sample) => (cells += sample.values.length))
  return cells
}

function cohortSummary(
  profile: PredictionWorkerModelProfile | null,
  totalRows: number,
): PredictionCohortSummary | null {
  if (!profile) return null
  return Object.freeze({
    totalRows,
    includedRows: profile.rowCount,
    includedMeasurementIds: profile.includedMeasurementIds,
    canonicalLayoutSignature: `${profile.direction}:${profile.inputSize}:${profile.outputSize}`,
    excluded: profile.excluded as PredictionCohortSummary['excluded'],
  })
}

export function PredictionWorkspace({
  active,
  authenticated,
  command,
  onActivity,
  onChromeStateChange,
  onRequestLogin,
  selectedCalculationId,
  varsContainer,
  workbench,
}: {
  active: boolean
  authenticated: boolean
  command: PredictionWorkspaceCommand | null
  onActivity?: RuntimeActivityCallback
  onChromeStateChange: (state: PredictionWorkspaceChromeState) => void
  onRequestLogin: () => void
  selectedCalculationId: number | null
  varsContainer: HTMLDivElement | null
  workbench: CaeWorkbenchState
}) {
  const clientRef = useRef<PredictionWorkerClient | null>(null)
  const generationRef = useRef(0)
  const loadRevisionRef = useRef(0)
  const autoLoadAttemptRef = useRef<string | null>(null)
  const referenceRevisionRef = useRef(0)
  const transactionRef = useRef(0)
  const validationRevisionRef = useRef(0)
  const validationActiveRef = useRef(false)
  const ownedCalculationDataOperationRef = useRef(false)
  const checkingFingerprintRef = useRef(0)
  const previousActiveRef = useRef(active)
  const previousPredictionBusyRef = useRef(false)
  const skipNextPredictionBusyCheckRef = useRef(false)
  const freshnessPendingRef = useRef(true)
  const dataStaleRef = useRef(false)
  const previousMutableDataBusyRef = useRef(workbench.measurementActions.busy || workbench.calculationDataActions.busy)
  const calculationAbortRef = useRef<AbortController | null>(null)
  const suppressedCandidateRef = useRef<string | null>(null)
  const lastCandidateRef = useRef('none')
  const modelCacheRef = useRef<Partial<Record<PredictionDirection, ModelCache>>>({})
  const forwardRowsRef = useRef<Readonly<{ key: string; rows: readonly PredictionTrainingRow[] }> | null>(null)
  const inverseRowsRef = useRef<Readonly<{ key: string; rows: readonly PredictionTrainingRow[] }> | null>(null)
  const cancelMeasurementRef = useRef(workbench.measurementActions.cancel)
  const cancelCalculationDataRef = useRef(workbench.calculationDataActions.cancel)

  const [context, setContext] = useState<PredictionContext | null>(null)
  const contextRef = useRef(context)
  const [setup, setSetup] = useState<PredictionSetup>(defaultSetup)
  const [setupDraft, setSetupDraft] = useState<PredictionSetup>(defaultSetup)
  const [setupAppliedRevision, setSetupAppliedRevision] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [setupBusyAction, setSetupBusyAction] = useState<PredictionSetupBusyAction>(null)
  const [direction, setDirection] = useState<PredictionDirection>('forward')
  const [status, setStatus] = useState('Prediction 데이터를 준비하세요.')
  const [busy, setBusy] = useState(false)
  const [validating, setValidating] = useState(false)
  const [retryingValidation, setRetryingValidation] = useState(false)
  const [dataStale, setDataStaleState] = useState(false)
  const [freshnessPending, setFreshnessPendingState] = useState(true)
  const [calculationValues, setCalculationValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [calculationEditorRevision, setCalculationEditorRevision] = useState(0)
  const [calculationErrors, setCalculationErrors] = useState<Readonly<Record<number, string>>>({})
  const [surrogateValues, setSurrogateValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [surrogateErrors, setSurrogateErrors] = useState<Readonly<Record<number, string>>>({})
  const [neighbors, setNeighbors] = useState<readonly PredictionNeighbor[]>([])
  const [profile, setProfile] = useState<PredictionWorkerModelProfile | null>(null)
  const [lastResult, setLastResult] = useState<PredictionResult | null>(null)
  const [forwardVarsFingerprint, setForwardVarsFingerprint] = useState<string | null>(null)
  const [inverseVarsFingerprint, setInverseVarsFingerprint] = useState<string | null>(null)
  const [referenceMeasurementId, setReferenceMeasurementId] = useState<number | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const calculationValuesRef = useRef(calculationValues)
  const busyRef = useRef(busy)
  calculationValuesRef.current = calculationValues
  busyRef.current = busy
  cancelMeasurementRef.current = workbench.measurementActions.cancel
  cancelCalculationDataRef.current = workbench.calculationDataActions.cancel

  const experimentId = workbench.experimentId
  const experimentIdRef = useRef(experimentId)
  const contextExperimentMatches = context?.experimentId === experimentId
  const varsSchema = workbench.experimentDocument.varsSchema as VarsSchema | null
  const candidateVars = workbench.candidateVars
  const currentCandidateFingerprint = candidateFingerprint(candidateVars)
  const candidateFingerprintRef = useRef(currentCandidateFingerprint)
  const selectedCalculations = useMemo(
    () =>
      contextExperimentMatches
        ? context.calculations.filter((calculation) => setup.calculationIds.includes(calculation.id))
        : [],
    [context, contextExperimentMatches, setup.calculationIds],
  )
  contextRef.current = context
  experimentIdRef.current = experimentId
  candidateFingerprintRef.current = currentCandidateFingerprint

  const setFreshnessPending = useCallback((pending: boolean) => {
    freshnessPendingRef.current = pending
    setFreshnessPendingState(pending)
  }, [])
  const setDataStale = useCallback((stale: boolean) => {
    dataStaleRef.current = stale
    setDataStaleState(stale)
  }, [])

  useEffect(() => {
    if (!clientRef.current) clientRef.current = new PredictionWorkerClient()
    return () => {
      clientRef.current?.dispose()
      clientRef.current = null
    }
  }, [])

  const cancelCurrent = useCallback(() => {
    loadRevisionRef.current += 1
    transactionRef.current += 1
    validationRevisionRef.current += 1
    referenceRevisionRef.current += 1
    calculationAbortRef.current?.abort()
    calculationAbortRef.current = null
    if (ownedCalculationDataOperationRef.current) cancelCalculationDataRef.current()
    ownedCalculationDataOperationRef.current = false
    const predictionCanceled = clientRef.current?.cancelPending() ?? false
    if (predictionCanceled) modelCacheRef.current = {}
    if (validationActiveRef.current) {
      cancelMeasurementRef.current()
      if (!predictionCanceled) clientRef.current?.reset()
      modelCacheRef.current = {}
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setDataStale(true)
    }
    validationActiveRef.current = false
    setBusy(false)
    setValidating(false)
    setRetryingValidation(false)
    setStatus('Prediction 작업을 취소했습니다.')
  }, [])

  useEffect(() => {
    const wasActive = previousActiveRef.current
    previousActiveRef.current = active
    if (!active) {
      autoLoadAttemptRef.current = null
      checkingFingerprintRef.current += 1
      skipNextPredictionBusyCheckRef.current = false
      setFreshnessPending(true)
    }
    if (wasActive && !active && (busyRef.current || ownedCalculationDataOperationRef.current)) cancelCurrent()
  }, [active, cancelCurrent, setFreshnessPending])

  const reloadData = useCallback(async () => {
    if (!authenticated || experimentId === null) {
      setContext(null)
      setStatus(
        authenticated ? '저장된 Experiment가 필요합니다.' : '로그인 후 Measurement 데이터를 사용할 수 있습니다.',
      )
      return
    }
    cancelCurrent()
    const revision = ++loadRevisionRef.current
    setFreshnessPending(true)
    setBusy(true)
    setStatus('Measurement와 CalculationData를 불러오는 중…')
    try {
      const listRequest = {
        ...getListRequest('visible'),
        limit: null,
        filter: { experiment_id: [experimentId, experimentId] },
      }
      const [calculationResponse, measurementResponse, analysis] = await Promise.all([
        dbTables.Calculation.listRows(listRequest),
        dbTables.Measurement.listRows(listRequest),
        dbTables.CalculationData.analysis(experimentId),
      ])
      if (revision !== loadRevisionRef.current) return
      transactionRef.current += 1
      referenceRevisionRef.current += 1
      calculationAbortRef.current?.abort()
      calculationAbortRef.current = null
      clientRef.current?.reset()
      const calculations = calculationResponse.items.filter(
        (row): row is SavedCalculation => typeof row.id === 'number',
      )
      const measurements = measurementResponse.items.filter(
        (row): row is SavedMeasurement => typeof row.id === 'number' && row.recorded_at !== null,
      )
      const fingerprint = predictionFingerprint([
        experimentId,
        analysis.fingerprint,
        measurements.map((row) => [row.id, row.updated_at, row.recorded_at]),
        calculations.map((row) => [row.id, row.updated_at, row.source_code]),
      ])
      setContext(
        Object.freeze({
          analysis,
          calculations: Object.freeze(calculations),
          experimentId,
          fingerprint,
          measurements: Object.freeze(measurements),
        }),
      )
      modelCacheRef.current = {}
      forwardRowsRef.current = null
      inverseRowsRef.current = null
      setProfile(null)
      setNeighbors([])
      setLastResult(null)
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      setCalculationErrors({})
      setDataStale(false)
      setFreshnessPending(false)
      skipNextPredictionBusyCheckRef.current = true
      setValidation(null)
      lastCandidateRef.current = currentCandidateFingerprint
      setSetup((current) => {
        const valid = current.calculationIds.filter((id) => calculations.some((row) => row.id === id))
        const fallback =
          valid.length > 0
            ? valid
            : [
                selectedCalculationId && calculations.some((row) => row.id === selectedCalculationId)
                  ? selectedCalculationId
                  : calculations[0]?.id,
              ].filter((id): id is number => typeof id === 'number')
        return Object.freeze({
          ...current,
          calculationIds: Object.freeze(fallback),
          calculationWeights: Object.freeze(
            Object.fromEntries(fallback.map((id) => [id, current.calculationWeights[id] ?? 1])),
          ),
        })
      })
      setSetupDraft((current) => {
        const valid = current.calculationIds.filter((id) => calculations.some((row) => row.id === id))
        return Object.freeze({
          ...current,
          calculationIds: Object.freeze(valid),
          calculationWeights: Object.freeze(
            Object.fromEntries(valid.map((id) => [id, current.calculationWeights[id] ?? 1])),
          ),
        })
      })
      setStatus(
        measurements.length
          ? `${measurements.length.toLocaleString()}개 Measurement 준비됨`
          : 'Recorded Measurement가 없습니다.',
      )
      setSetupAppliedRevision((current) => current + 1)
    } catch (cause: unknown) {
      if (revision !== loadRevisionRef.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus(message)
      toast.error(message)
    } finally {
      if (revision === loadRevisionRef.current) setBusy(false)
    }
  }, [
    authenticated,
    cancelCurrent,
    currentCandidateFingerprint,
    experimentId,
    selectedCalculationId,
    setFreshnessPending,
  ])

  useLayoutEffect(() => {
    validationRevisionRef.current += 1
    validationActiveRef.current = false
    clientRef.current?.reset()
    modelCacheRef.current = {}
    forwardRowsRef.current = null
    inverseRowsRef.current = null
    setContext(null)
    setValidation(null)
    setDetailsOpen(false)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationEditorRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setDirection('forward')
    setProfile(null)
    setNeighbors([])
    lastCandidateRef.current = 'none'
    if (active) {
      autoLoadAttemptRef.current = `${authenticated}:${experimentId ?? 'none'}`
      void reloadData()
    }
  }, [experimentId])

  useEffect(() => {
    const loadKey = `${authenticated}:${experimentId ?? 'none'}`
    if (!active || !authenticated || context || busy || autoLoadAttemptRef.current === loadKey) return
    autoLoadAttemptRef.current = loadKey
    void reloadData()
  }, [active, authenticated, busy, context, experimentId, reloadData])

  useEffect(() => {
    if (authenticated) return
    autoLoadAttemptRef.current = null
    loadRevisionRef.current += 1
    cancelCurrent()
    clientRef.current?.reset()
    modelCacheRef.current = {}
    forwardRowsRef.current = null
    inverseRowsRef.current = null
    setContext(null)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationEditorRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setProfile(null)
    setNeighbors([])
    setLastResult(null)
    setForwardVarsFingerprint(null)
    setInverseVarsFingerprint(null)
    setStatus('로그인 후 Measurement 데이터를 사용할 수 있습니다.')
  }, [authenticated, cancelCurrent])

  const checkDataFingerprint = useCallback(async () => {
    if (!authenticated || experimentId === null || !context || context.experimentId !== experimentId || busyRef.current)
      return
    setFreshnessPending(true)
    const checkRevision = ++checkingFingerprintRef.current
    const loadRevision = loadRevisionRef.current
    try {
      const listRequest = {
        ...getListRequest('visible'),
        limit: null,
        filter: { experiment_id: [experimentId, experimentId] },
      }
      const [calculationResponse, measurementResponse, analysisStatus] = await Promise.all([
        dbTables.Calculation.listRows(listRequest),
        dbTables.Measurement.listRows(listRequest),
        dbTables.CalculationData.analysisStatus(experimentId),
      ])
      if (
        checkRevision !== checkingFingerprintRef.current ||
        loadRevision !== loadRevisionRef.current ||
        experimentIdRef.current !== experimentId ||
        contextRef.current !== context
      )
        return
      const calculations = calculationResponse.items.filter(
        (row): row is SavedCalculation => typeof row.id === 'number',
      )
      const measurements = measurementResponse.items.filter(
        (row): row is SavedMeasurement => typeof row.id === 'number' && row.recorded_at !== null,
      )
      const fingerprint = predictionFingerprint([
        experimentId,
        analysisStatus.fingerprint,
        measurements.map((row) => [row.id, row.updated_at, row.recorded_at]),
        calculations.map((row) => [row.id, row.updated_at, row.source_code]),
      ])
      if (fingerprint !== context.fingerprint) {
        transactionRef.current += 1
        referenceRevisionRef.current += 1
        calculationAbortRef.current?.abort()
        calculationAbortRef.current = null
        clientRef.current?.reset()
        modelCacheRef.current = {}
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setDataStale(true)
        setStatus('Measurement 또는 Calculation이 변경되었습니다. Reload Data로 모델을 갱신하세요.')
      }
      setFreshnessPending(false)
    } catch {
      if (
        checkRevision === checkingFingerprintRef.current &&
        loadRevision === loadRevisionRef.current &&
        experimentIdRef.current === experimentId &&
        contextRef.current === context
      ) {
        setStatus('Prediction 데이터 최신성을 확인하지 못했습니다. Reload Data를 실행하세요.')
      }
    }
  }, [authenticated, context, experimentId, setFreshnessPending])

  useEffect(() => {
    if (!active) return
    void checkDataFingerprint()
    const onFocus = () => void checkDataFingerprint()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [active, checkDataFingerprint])

  useEffect(() => {
    const mutableDataBusy = workbench.measurementActions.busy || workbench.calculationDataActions.busy
    const wasBusy = previousMutableDataBusyRef.current
    previousMutableDataBusyRef.current = mutableDataBusy
    if (!active) return
    if (mutableDataBusy) {
      checkingFingerprintRef.current += 1
      setFreshnessPending(true)
    } else if (wasBusy) void checkDataFingerprint()
  }, [
    active,
    checkDataFingerprint,
    setFreshnessPending,
    workbench.calculationDataActions.busy,
    workbench.measurementActions.busy,
  ])

  useEffect(() => {
    const wasBusy = previousPredictionBusyRef.current
    previousPredictionBusyRef.current = busy
    if (active && wasBusy && !busy && !workbench.measurementActions.busy && !workbench.calculationDataActions.busy) {
      if (skipNextPredictionBusyCheckRef.current) skipNextPredictionBusyCheckRef.current = false
      else void checkDataFingerprint()
    }
  }, [active, busy, checkDataFingerprint, workbench.calculationDataActions.busy, workbench.measurementActions.busy])

  const ensureForwardModel = useCallback(
    async (transaction: number) => {
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !clientRef.current)
        throw new Error('Forward 모델 context가 준비되지 않았습니다.')
      const rules = recordedDataRules(
        workbench.experimentDocument.simulationProgram?.recordedData ?? Object.freeze({}),
        'prediction.forward',
      )
      if (!rules.length) throw new Error('현재 Experiment에 RecordedData schema가 없습니다.')
      if (rules.some((rule) => rule.result.dtype === 'bool' || rule.result.dtype === 'string')) {
        throw new Error('Forward Prediction은 모든 RecordedData leaf가 numeric일 때만 사용할 수 있습니다.')
      }
      const fingerprint = predictionFingerprint([
        context.fingerprint,
        'forward',
        setup.kMode === 'manual' ? setup.manualK : 'auto',
        setup.weighting,
        predictionVarsLayouts(varsSchema),
        rules,
      ])
      const cached = modelCacheRef.current.forward
      if (cached?.fingerprint === fingerprint && cached.workerEpoch === clientRef.current.epoch)
        return { ...cached, rules }
      const rowsKey = predictionFingerprint([context.fingerprint, predictionVarsLayouts(varsSchema), rules])
      let rows = forwardRowsRef.current?.key === rowsKey ? forwardRowsRef.current.rows : null
      if (!rows) {
        const collected: PredictionTrainingRow[] = []
        let collectedCells = 0
        await rowsInBatches(context.measurements, 4, async (measurement) => {
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const tree = await dbTables.Measurement.readRecordedData(measurement.id)
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          let row: PredictionTrainingRow
          try {
            const recorded = predictionRecordedSamples(tree, measurement.id)
            if (!predictionRecordedSamplesMatchRules(recorded.samples, rules)) {
              throw new Error('Stored RecordedData schema differs from the current Experiment.')
            }
            row = forwardTrainingRow(measurement, recorded, varsSchema)
          } catch {
            row = Object.freeze({
              measurementId: measurement.id,
              inputs: Object.freeze([]),
              outputs: Object.freeze([]),
            })
          }
          collectedCells += trainingRowCellCount(row)
          if (!Number.isSafeInteger(collectedCells) || collectedCells > PREDICTION_NUMERIC_CELL_LIMIT)
            throw new Error(
              `Prediction training data contains more than ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()} numeric cells.`,
            )
          collected.push(row)
        })
        if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
        rows = Object.freeze(collected)
        forwardRowsRef.current = Object.freeze({ key: rowsKey, rows })
      }
      assertTrainingCellLimit(rows)
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      const generation = ++generationRef.current
      const profile = await clientRef.current
        .build('forward', generation, fingerprint, {
          direction: 'forward',
          fingerprint,
          inputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
          outputKeys: rules.map((rule) => rule.label),
          rows,
          fixedInputLayouts: predictionVarsLayouts(varsSchema),
          inputScaling: 'range',
          weighting: setup.weighting,
          ...(setup.kMode === 'manual' ? { k: setup.manualK } : {}),
        })
        .finally(() => {
          if (forwardRowsRef.current?.rows === rows) forwardRowsRef.current = null
        })
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      const next = Object.freeze({ fingerprint, generation, profile, workerEpoch: clientRef.current.epoch })
      modelCacheRef.current = { ...modelCacheRef.current, forward: next }
      return { ...next, rules }
    },
    [
      context,
      experimentId,
      setup.kMode,
      setup.manualK,
      setup.weighting,
      varsSchema,
      workbench.experimentDocument.simulationProgram?.recordedData,
    ],
  )

  const fetchSelectedCalculationData = useCallback(
    async (measurementId?: number, transaction?: number) => {
      if (!context || experimentId === null || context.experimentId !== experimentId)
        throw new Error('CalculationData context가 없습니다.')
      const ids = context.analysis.items
        .filter(
          (item) =>
            setup.calculationIds.includes(item.calculation_id) &&
            (measurementId === undefined || item.measurement_id === measurementId),
        )
        .map((item) => item.calculation_data_id)
      const records: CalculationDataRecord[] = []
      let numericCells = 0
      for (let offset = 0; offset < ids.length; offset += 50) {
        if (transaction !== undefined && transaction !== transactionRef.current)
          throw new DOMException('Stale Prediction transaction', 'AbortError')
        const selectedIds = ids.slice(offset, offset + 50)
        if (!selectedIds.length) continue
        const response = await dbTables.CalculationData.listRows({
          ...getListRequest('visible', selectedIds),
          experiment_id: experimentId,
          limit: selectedIds.length,
          sort: ['id', 'asc'],
        })
        if (transaction !== undefined && transaction !== transactionRef.current)
          throw new DOMException('Stale Prediction transaction', 'AbortError')
        response.items.forEach((record) => {
          numericCells += record.data.shape.length === 0 ? 1 : (record.data.data as readonly number[]).length
        })
        if (!Number.isSafeInteger(numericCells) || numericCells > PREDICTION_NUMERIC_CELL_LIMIT)
          throw new Error(
            `Prediction CalculationData contains more than ${PREDICTION_NUMERIC_CELL_LIMIT.toLocaleString()} numeric cells.`,
          )
        records.push(...response.items)
      }
      return Object.freeze(records)
    },
    [context, experimentId, setup.calculationIds],
  )

  const ensureInverseModel = useCallback(
    async (transaction: number) => {
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !clientRef.current)
        throw new Error('Inverse 모델 context가 준비되지 않았습니다.')
      if (!setup.calculationIds.length) throw new Error('Inverse에 사용할 Calculation을 선택하세요.')
      const fingerprint = predictionFingerprint([
        context.fingerprint,
        'inverse',
        setup.calculationIds,
        setup.calculationWeights,
        setup.kMode === 'manual' ? setup.manualK : 'auto',
        setup.weighting,
        predictionVarsLayouts(varsSchema),
      ])
      const cached = modelCacheRef.current.inverse
      if (cached?.fingerprint === fingerprint && cached.workerEpoch === clientRef.current.epoch) return cached
      const rowsKey = predictionFingerprint([
        context.fingerprint,
        setup.calculationIds,
        predictionVarsLayouts(varsSchema),
      ])
      let rows = inverseRowsRef.current?.key === rowsKey ? inverseRowsRef.current.rows : null
      if (!rows) {
        const records = await fetchSelectedCalculationData(undefined, transaction)
        rows = inverseTrainingRows(context.measurements, records, setup.calculationIds, varsSchema)
        if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
        inverseRowsRef.current = Object.freeze({ key: rowsKey, rows })
      }
      assertTrainingCellLimit(rows)
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      const generation = ++generationRef.current
      const inputBlockWeights = Object.freeze(
        Object.fromEntries(setup.calculationIds.map((id) => [`calculation:${id}`, setup.calculationWeights[id] ?? 1])),
      )
      const profile = await clientRef.current
        .build('inverse', generation, fingerprint, {
          direction: 'inverse',
          fingerprint,
          inputKeys: setup.calculationIds.map((id) => `calculation:${id}`),
          outputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
          rows,
          fixedOutputLayouts: predictionVarsLayouts(varsSchema),
          inputBlockWeights,
          inputScaling: 'standard-deviation',
          weighting: setup.weighting,
          ...(setup.kMode === 'manual' ? { k: setup.manualK } : {}),
        })
        .finally(() => {
          if (inverseRowsRef.current?.rows === rows) inverseRowsRef.current = null
        })
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      const next = Object.freeze({ fingerprint, generation, profile, workerEpoch: clientRef.current.epoch })
      modelCacheRef.current = { ...modelCacheRef.current, inverse: next }
      return next
    },
    [context, experimentId, fetchSelectedCalculationData, setup, varsSchema],
  )

  const executeCalculations = useCallback(
    async (input: NonNullable<ReturnType<typeof buildCalculationRecordedData>['input']>, transaction: number) => {
      const controller = new AbortController()
      calculationAbortRef.current?.abort()
      calculationAbortRef.current = controller
      const values: Record<number, CalculationDataOutput> = {}
      const errors: Record<number, string> = {}
      await rowsInBatches(selectedCalculations, 2, async (calculation) => {
        try {
          const output = await runCalculation({
            input,
            sourceCode: calculation.source_code,
            signal: controller.signal,
            onLog: (entry) =>
              onActivity?.({
                source: 'calculation',
                level: 'info',
                phase: 'prediction',
                message: `[Prediction · Calculation #${calculation.id}] ${entry.message}`,
                runId: entry.requestId,
              }),
          })
          values[calculation.id] = output
        } catch (cause: unknown) {
          if (!controller.signal.aborted)
            errors[calculation.id] = cause instanceof Error ? cause.message : String(cause)
        }
      })
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      return Object.freeze({ values: Object.freeze(values), errors: Object.freeze(errors) })
    },
    [onActivity, selectedCalculations],
  )

  const forwardOutputs = useCallback(
    async (vars: Readonly<Vars>, transaction: number) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const model = await ensureForwardModel(transaction)
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const result = await clientRef.current!.predict(
            'forward',
            model.generation,
            model.fingerprint,
            predictionVarsSamples(vars, varsSchema!),
          )
          const recorded = predictedRecordedData(result.output, model.rules)
          const input = buildCalculationRecordedData(model.rules, recorded)
          if (!input.input)
            throw new Error(input.error ?? '예측 RecordedData를 Calculation input으로 만들 수 없습니다.')
          return { calculated: await executeCalculations(input.input, transaction), model, result }
        } catch (cause: unknown) {
          if (!(cause instanceof PredictionWorkerRestartError) || attempt > 0 || transaction !== transactionRef.current)
            throw cause
          modelCacheRef.current = {}
        }
      }
      throw new Error('Prediction Worker 재시도에 실패했습니다.')
    },
    [ensureForwardModel, executeCalculations, varsSchema],
  )

  const runForward = useCallback(
    async (vars: Readonly<Vars>) => {
      if (
        freshnessPendingRef.current ||
        dataStaleRef.current ||
        !context ||
        context.experimentId !== experimentId ||
        !setup.calculationIds.length
      )
        return
      referenceRevisionRef.current += 1
      const transaction = ++transactionRef.current
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) modelCacheRef.current = {}
      setDirection('forward')
      setBusy(true)
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setStatus('Forward · RecordedData를 예측하는 중…')
      try {
        const completed = await forwardOutputs(vars, transaction)
        if (transaction !== transactionRef.current) return
        calculationValuesRef.current = completed.calculated.values
        setCalculationValues(completed.calculated.values)
        setCalculationEditorRevision((current) => current + 1)
        setCalculationErrors(completed.calculated.errors)
        setSurrogateValues({})
        setSurrogateErrors({})
        setNeighbors(completed.result.neighbors)
        setLastResult(completed.result)
        setProfile(completed.model.profile)
        setForwardVarsFingerprint(candidateFingerprint(vars))
        setInverseVarsFingerprint(null)
        setStatus(
          Object.keys(completed.calculated.errors).length
            ? 'Forward 완료 · 일부 Calculation 실패'
            : 'Forward 완료 · CalculationData가 최신입니다.',
        )
      } catch (cause: unknown) {
        if (transaction !== transactionRef.current || (cause as { name?: string })?.name === 'AbortError') return
        modelCacheRef.current = {}
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        toast.error(message)
      } finally {
        if (transaction === transactionRef.current) setBusy(false)
      }
    },
    [context, experimentId, forwardOutputs, setup.calculationIds.length],
  )

  const runInverse = useCallback(
    async (targets: Readonly<Record<number, CalculationDataOutput>>) => {
      if (
        freshnessPendingRef.current ||
        dataStaleRef.current ||
        !context ||
        context.experimentId !== experimentId ||
        !varsSchema ||
        setup.calculationIds.some((id) => !targets[id])
      )
        return
      referenceRevisionRef.current += 1
      const transaction = ++transactionRef.current
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) modelCacheRef.current = {}
      setDirection('inverse')
      setBusy(true)
      setInverseVarsFingerprint(null)
      setForwardVarsFingerprint(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      setStatus('Inverse · Vars를 예측하는 중…')
      try {
        const query = setup.calculationIds.map((id) => calculationOutputSample(id, targets[id]))
        let prediction: Readonly<{ model: ModelCache; result: PredictionResult }> | null = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const model = await ensureInverseModel(transaction)
            if (transaction !== transactionRef.current) return
            const result = await clientRef.current!.predict('inverse', model.generation, model.fingerprint, query)
            prediction = Object.freeze({ model, result })
            break
          } catch (cause: unknown) {
            if (
              !(cause instanceof PredictionWorkerRestartError) ||
              attempt > 0 ||
              transaction !== transactionRef.current
            )
              throw cause
            modelCacheRef.current = {}
          }
        }
        if (!prediction) throw new Error('Prediction Worker 재시도에 실패했습니다.')
        const { model, result } = prediction
        const nextVars = Object.freeze(
          Object.fromEntries(
            result.output.map((sample) => [sample.layout.key, varsTensorFromFlat(sample.values, sample.layout.shape)]),
          ),
        ) as Readonly<Vars>
        const nextFingerprint = candidateFingerprint(nextVars)
        if (!workbench.setCandidateVariables(nextVars, 'prediction-inverse')) {
          throw new Error('Inverse Vars가 현재 varsSchema를 통과하지 못했습니다.')
        }
        suppressedCandidateRef.current = nextFingerprint
        setInverseVarsFingerprint(nextFingerprint)
        setForwardVarsFingerprint(null)
        setNeighbors(result.neighbors)
        setLastResult(result)
        setProfile(model.profile)
        setStatus('Inverse 완료 · Viewer를 갱신하고 surrogate를 계산하는 중…')
        try {
          const surrogate = await forwardOutputs(nextVars, transaction)
          if (transaction !== transactionRef.current) return
          setSurrogateValues(surrogate.calculated.values)
          setSurrogateErrors(surrogate.calculated.errors)
          setStatus(
            Object.keys(surrogate.calculated.errors).length
              ? 'Inverse 완료 · 일부 Forward surrogate Calculation이 실패했습니다.'
              : 'Inverse 완료 · Target은 유지되고 Vars가 적용되었습니다.',
          )
        } catch (cause: unknown) {
          if (transaction !== transactionRef.current) return
          modelCacheRef.current = {}
          setSurrogateValues({})
          setSurrogateErrors({})
          setStatus(`Inverse 완료 · surrogate unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      } catch (cause: unknown) {
        if (transaction !== transactionRef.current || (cause as { name?: string })?.name === 'AbortError') return
        modelCacheRef.current = {}
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        toast.error(message)
      } finally {
        if (transaction === transactionRef.current) setBusy(false)
      }
    },
    [context, ensureInverseModel, experimentId, forwardOutputs, setup.calculationIds, varsSchema, workbench],
  )

  useEffect(() => {
    if (
      !active ||
      freshnessPending ||
      dataStale ||
      !contextExperimentMatches ||
      !candidateVars ||
      !setup.calculationIds.length
    )
      return
    if (currentCandidateFingerprint === lastCandidateRef.current) return
    lastCandidateRef.current = currentCandidateFingerprint
    if (suppressedCandidateRef.current === currentCandidateFingerprint) {
      suppressedCandidateRef.current = null
      return
    }
    void runForward(candidateVars)
  }, [
    active,
    candidateVars,
    contextExperimentMatches,
    currentCandidateFingerprint,
    dataStale,
    freshnessPending,
    runForward,
    setup.calculationIds.length,
  ])

  const changeCalculationOutput = useCallback(
    (calculationId: number, output: CalculationDataOutput) => {
      if (freshnessPendingRef.current || dataStaleRef.current) return
      referenceRevisionRef.current += 1
      transactionRef.current += 1
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) modelCacheRef.current = {}
      setDirection('inverse')
      setReferenceMeasurementId(null)
      setInverseVarsFingerprint(null)
      setForwardVarsFingerprint(null)
      setValidation(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      const next = Object.freeze({ ...calculationValuesRef.current, [calculationId]: output })
      calculationValuesRef.current = next
      setCalculationValues(next)
      setCalculationEditorRevision((current) => current + 1)
      if (setup.calculationIds.every((id) => next[id])) void runInverse(next)
      else {
        setBusy(false)
        setStatus('Inverse 대기 · 선택한 모든 CalculationData Target을 채우세요.')
      }
    },
    [runInverse, setup.calculationIds],
  )

  const loadReferenceMeasurement = useCallback(
    async (measurementId: number, preserveExistingTargets = false) => {
      if (freshnessPendingRef.current || dataStaleRef.current) return
      const referenceRevision = ++referenceRevisionRef.current
      const transaction = ++transactionRef.current
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) modelCacheRef.current = {}
      setBusy(true)
      setStatus(`Measurement #${measurementId} Target을 불러오는 중…`)
      try {
        setInverseVarsFingerprint(null)
        setForwardVarsFingerprint(null)
        setValidation(null)
        setSurrogateValues({})
        setSurrogateErrors({})
        const records = await fetchSelectedCalculationData(measurementId, transaction)
        if (referenceRevision !== referenceRevisionRef.current || transaction !== transactionRef.current) return
        const values = Object.fromEntries(records.map((record) => [record.calculation_id, record.data]))
        const nextValues: Record<number, CalculationDataOutput> = preserveExistingTargets
          ? { ...calculationValuesRef.current }
          : {}
        setup.calculationIds.forEach((id) => {
          if (!nextValues[id] && values[id]) nextValues[id] = values[id]
        })
        if (setup.calculationIds.some((id) => !nextValues[id])) {
          throw new Error('선택한 CalculationData Target을 모두 채울 수 있는 Measurement가 아닙니다.')
        }
        const frozen = Object.freeze(nextValues)
        setReferenceMeasurementId(preserveExistingTargets ? null : measurementId)
        calculationValuesRef.current = frozen
        setCalculationValues(frozen)
        setCalculationEditorRevision((current) => current + 1)
        setCalculationErrors({})
        setDirection('inverse')
        await runInverse(frozen)
      } catch (cause: unknown) {
        if (referenceRevision !== referenceRevisionRef.current || transaction !== transactionRef.current) return
        setStatus(cause instanceof Error ? cause.message : String(cause))
        toast.error(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (referenceRevision === referenceRevisionRef.current && transaction === transactionRef.current) setBusy(false)
      }
    },
    [fetchSelectedCalculationData, runInverse, setup.calculationIds],
  )

  const referenceMeasurements = useMemo(() => {
    if (!context || context.experimentId !== experimentId || !setup.calculationIds.length) return []
    const counts = new Map<number, Set<number>>()
    context.analysis.items.forEach((item) => {
      if (!setup.calculationIds.includes(item.calculation_id)) return
      const ids = counts.get(item.measurement_id) ?? new Set<number>()
      ids.add(item.calculation_id)
      counts.set(item.measurement_id, ids)
    })
    return context.measurements
      .filter((measurement) => counts.get(measurement.id)?.size === setup.calculationIds.length)
      .map((measurement) => ({ id: measurement.id, label: `Measurement #${measurement.id}` }))
  }, [context, experimentId, setup.calculationIds])

  const validationDisabledReason = useMemo(() => {
    if (!authenticated) return '로그인 후 검증할 수 있습니다.'
    if (!contextExperimentMatches) return '현재 Experiment의 Prediction 데이터를 불러오는 중입니다.'
    if (freshnessPending) return 'Prediction 데이터 최신성을 확인하는 중입니다.'
    if (!workbench.experimentClean || experimentId === null) return '저장되고 수정되지 않은 Experiment가 필요합니다.'
    if (busy || workbench.measurementActions.busy || workbench.calculationDataActions.busy)
      return '진행 중인 작업이 있습니다.'
    if (dataStale) return 'Prediction 데이터를 Reload하세요.'
    if (workbench.experimentDocument.runIsBusy) return 'Candidate 평가가 완료될 때까지 기다리세요.'
    if (
      workbench.experimentDocument.status !== 'Ready' ||
      workbench.experimentDocument.successfulRevision !== workbench.experimentDocument.revision ||
      !workbench.experimentDocument.variables ||
      !workbench.experimentDocument.materialParameters ||
      candidateFingerprint(workbench.experimentDocument.variables) !== currentCandidateFingerprint
    ) {
      return '현재 Candidate의 평가 결과가 준비되지 않았습니다.'
    }
    if (workbench.experimentDocument.draftTaskNames.length > 0) {
      return 'Solver가 선택되지 않은 Draft Task가 있어 검증할 수 없습니다.'
    }
    if (setup.calculationIds.some((id) => !calculationValues[id])) return '모든 선택 Calculation의 값이 필요합니다.'
    if (direction === 'forward' && forwardVarsFingerprint !== currentCandidateFingerprint)
      return '현재 Vars와 Forward 결과가 다릅니다.'
    if (direction === 'inverse' && inverseVarsFingerprint !== currentCandidateFingerprint)
      return '현재 Vars가 최신 Inverse 결과가 아닙니다.'
    return undefined
  }, [
    authenticated,
    busy,
    calculationValues,
    contextExperimentMatches,
    currentCandidateFingerprint,
    dataStale,
    direction,
    experimentId,
    forwardVarsFingerprint,
    freshnessPending,
    inverseVarsFingerprint,
    setup.calculationIds,
    workbench.calculationDataActions.busy,
    workbench.experimentDocument.draftTaskNames,
    workbench.experimentDocument.materialParameters,
    workbench.experimentDocument.revision,
    workbench.experimentDocument.runIsBusy,
    workbench.experimentClean,
    workbench.experimentDocument.status,
    workbench.experimentDocument.successfulRevision,
    workbench.experimentDocument.variables,
    workbench.measurementActions.busy,
  ])

  const validatePrediction = useCallback(async () => {
    if (freshnessPendingRef.current) {
      toast.error('Prediction 데이터 최신성을 확인하는 중입니다.')
      return
    }
    if (validationDisabledReason) {
      toast.error(validationDisabledReason)
      return
    }
    const validationRevision = ++validationRevisionRef.current
    validationActiveRef.current = true
    const calculationIds = Object.freeze([...setup.calculationIds])
    const reference = Object.freeze({ ...calculationValues })
    const frozenDirection = direction
    const frozenProfile = profile
    const frozenModelFingerprint = modelCacheRef.current[direction]?.fingerprint ?? null
    const frozenReferenceRevision = referenceRevisionRef.current
    const frozenRepredicted = Object.freeze(frozenDirection === 'inverse' ? { ...surrogateValues } : {})
    const frozenSetup = setup
    const frozenTransactionId = transactionRef.current
    setBusy(true)
    setValidating(true)
    setSetupOpen(false)
    setDetailsOpen(true)
    setStatus('Validation · Candidate 저장과 Simulation 실행 중…')
    let datasetMutated = false
    try {
      const sourceFingerprintEntries = Object.freeze(
        await Promise.all(
          selectedCalculations.map(
            async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
          ),
        ),
      )
      if (validationRevision !== validationRevisionRef.current) return
      if (candidateFingerprintRef.current !== currentCandidateFingerprint) {
        throw new Error('Validation 준비 중 Candidate Vars가 변경되었습니다. 다시 시도하세요.')
      }
      const sourceFingerprints = new Map(sourceFingerprintEntries)
      const snapshotFingerprint = predictionFingerprint([
        frozenDirection,
        currentCandidateFingerprint,
        frozenReferenceRevision,
        frozenTransactionId,
        calculationIds,
        reference,
        frozenRepredicted,
        sourceFingerprintEntries,
        frozenSetup,
        frozenModelFingerprint,
      ])
      const completion = await workbench.measurementActions.saveAndRunCurrentAsync()
      if (validationRevision !== validationRevisionRef.current) return
      datasetMutated = true
      const [analysis, currentCalculationResponse] = await Promise.all([
        dbTables.CalculationData.analysis(experimentId!),
        dbTables.Calculation.listRows({
          ...getListRequest('visible', [...calculationIds]),
          filter: { experiment_id: [experimentId!, experimentId!] },
          limit: calculationIds.length,
        }),
      ])
      if (validationRevision !== validationRevisionRef.current) return
      const currentSourceFingerprints = new Map(
        await Promise.all(
          currentCalculationResponse.items
            .filter((calculation): calculation is SavedCalculation => typeof calculation.id === 'number')
            .map(
              async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
            ),
        ),
      )
      if (validationRevision !== validationRevisionRef.current) return
      const ids = analysis.items
        .filter(
          (item) => item.measurement_id === completion.measurementId && calculationIds.includes(item.calculation_id),
        )
        .map((item) => item.calculation_data_id)
      const actual: CalculationDataRecord[] = []
      for (let offset = 0; offset < ids.length; offset += 50) {
        const selectedIds = ids.slice(offset, offset + 50)
        const response = await dbTables.CalculationData.listRows({
          ...getListRequest('visible', selectedIds),
          experiment_id: experimentId!,
          limit: selectedIds.length,
          sort: ['id', 'asc'],
        })
        if (validationRevision !== validationRevisionRef.current) return
        actual.push(...response.items)
      }
      if (validationRevision !== validationRevisionRef.current) return
      const byCalculation = new Map(actual.map((record) => [record.calculation_id, record]))
      const rows = calculationIds.map((calculationId): ValidationRow => {
        const record = byCalculation.get(calculationId)
        if (sourceFingerprints.get(calculationId) !== currentSourceFingerprints.get(calculationId)) {
          return Object.freeze({
            actual: record?.data ?? null,
            calculationId,
            metric: null,
            error: 'Calculation source가 Validation snapshot과 다릅니다.',
            reference: reference[calculationId],
          })
        }
        if (!record) {
          return Object.freeze({
            actual: null,
            calculationId,
            metric: null,
            error: '실제 CalculationData가 저장되지 않았습니다.',
            reference: reference[calculationId],
          })
        }
        return Object.freeze({
          actual: record.data,
          calculationId,
          metric: comparePredictionOutput(reference[calculationId], record.data),
          error: null,
          reference: reference[calculationId],
        })
      })
      const failed = rows.filter((row) => row.error || !row.metric?.compatible).length
      const aggregateError =
        frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse'
          ? inverseValidationAggregateErrorFromScales(
              rows,
              frozenSetup.calculationWeights,
              frozenProfile.inputLayouts,
              frozenProfile.inputScales,
            )
          : null
      const summary = `Measurement #${completion.measurementId} · ${frozenDirection} 검증 · ${rows.length - failed}/${rows.length}개 비교 완료${aggregateError === null ? '' : ` · Aggregate ${aggregateError.toPrecision(5)}`}`
      setValidation(
        Object.freeze({
          aggregateError,
          candidateVarsFingerprint: currentCandidateFingerprint,
          calculationWeights: frozenSetup.calculationWeights,
          direction: frozenDirection,
          experimentId: experimentId!,
          inverseInputLayouts:
            frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse' ? frozenProfile.inputLayouts : null,
          inverseInputScales:
            frozenDirection === 'inverse' && frozenProfile?.direction === 'inverse' ? frozenProfile.inputScales : null,
          measurementId: completion.measurementId,
          referenceRevision: frozenReferenceRevision,
          repredicted: frozenRepredicted,
          rows: Object.freeze(rows),
          snapshotFingerprint,
          sourceFingerprints: Object.freeze(Object.fromEntries(sourceFingerprintEntries)),
          setupFingerprint: predictionFingerprint([frozenSetup]),
          summary,
          transactionId: frozenTransactionId,
        }),
      )
      setStatus(summary)
      clientRef.current?.reset()
      modelCacheRef.current = {}
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setDataStale(true)
    } catch (cause: unknown) {
      if (validationRevision !== validationRevisionRef.current) return
      if (datasetMutated) {
        clientRef.current?.reset()
        modelCacheRef.current = {}
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setDataStale(true)
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus(`Validation 실패 · ${message}`)
      toast.error(message)
    } finally {
      if (validationRevision === validationRevisionRef.current) {
        validationActiveRef.current = false
        setBusy(false)
        setValidating(false)
      }
    }
  }, [
    calculationValues,
    direction,
    experimentId,
    setup.calculationIds,
    surrogateValues,
    validationDisabledReason,
    workbench.measurementActions,
  ])

  const retryValidationCalculations = useCallback(async () => {
    if (
      !validation ||
      experimentId === null ||
      validation.experimentId !== experimentId ||
      !contextExperimentMatches ||
      busyRef.current ||
      freshnessPendingRef.current ||
      !validation.rows.some((row) => row.error)
    )
      return
    const validationRevision = ++validationRevisionRef.current
    validationActiveRef.current = true
    const calculationIds = Object.freeze(validation.rows.map((row) => row.calculationId))
    setBusy(true)
    setValidating(true)
    setRetryingValidation(true)
    setStatus(`Validation · Measurement #${validation.measurementId} Calculation 재시도 중…`)
    try {
      ownedCalculationDataOperationRef.current = true
      await workbench.calculationDataActions.calculateMeasurement(validation.measurementId, { announce: true })
      ownedCalculationDataOperationRef.current = false
      if (validationRevision !== validationRevisionRef.current) return
      const [analysis, currentCalculationResponse] = await Promise.all([
        dbTables.CalculationData.analysis(experimentId),
        dbTables.Calculation.listRows({
          ...getListRequest('visible', [...calculationIds]),
          filter: { experiment_id: [experimentId, experimentId] },
          limit: calculationIds.length,
        }),
      ])
      if (validationRevision !== validationRevisionRef.current) return
      const currentSourceFingerprints = new Map(
        await Promise.all(
          currentCalculationResponse.items
            .filter((calculation): calculation is SavedCalculation => typeof calculation.id === 'number')
            .map(
              async (calculation) => [calculation.id, await calculationSourceHash(calculation.source_code)] as const,
            ),
        ),
      )
      if (validationRevision !== validationRevisionRef.current) return
      const ids = analysis.items
        .filter(
          (item) => item.measurement_id === validation.measurementId && calculationIds.includes(item.calculation_id),
        )
        .map((item) => item.calculation_data_id)
      const actual: CalculationDataRecord[] = []
      for (let offset = 0; offset < ids.length; offset += 50) {
        const selectedIds = ids.slice(offset, offset + 50)
        const response = await dbTables.CalculationData.listRows({
          ...getListRequest('visible', selectedIds),
          experiment_id: experimentId,
          limit: selectedIds.length,
          sort: ['id', 'asc'],
        })
        if (validationRevision !== validationRevisionRef.current) return
        actual.push(...response.items)
      }
      const byCalculation = new Map(actual.map((record) => [record.calculation_id, record]))
      const rows = validation.rows.map((previous): ValidationRow => {
        const record = byCalculation.get(previous.calculationId)
        if (
          validation.sourceFingerprints[previous.calculationId] !==
          currentSourceFingerprints.get(previous.calculationId)
        ) {
          return Object.freeze({
            ...previous,
            actual: record?.data ?? null,
            metric: null,
            error: 'Calculation source가 Validation snapshot과 다릅니다.',
          })
        }
        if (!record) {
          return Object.freeze({
            ...previous,
            actual: null,
            metric: null,
            error: '실제 CalculationData가 저장되지 않았습니다.',
          })
        }
        return Object.freeze({
          ...previous,
          actual: record.data,
          metric: comparePredictionOutput(previous.reference, record.data),
          error: null,
        })
      })
      const failed = rows.filter((row) => row.error || !row.metric?.compatible).length
      const aggregateError =
        validation.direction === 'inverse' && validation.inverseInputLayouts && validation.inverseInputScales
          ? inverseValidationAggregateErrorFromScales(
              rows,
              validation.calculationWeights,
              validation.inverseInputLayouts,
              validation.inverseInputScales,
            )
          : null
      const summary = `Measurement #${validation.measurementId} · ${validation.direction} 검증 · ${rows.length - failed}/${rows.length}개 비교 완료${aggregateError === null ? '' : ` · Aggregate ${aggregateError.toPrecision(5)}`}`
      setValidation(
        Object.freeze({
          ...validation,
          aggregateError,
          rows: Object.freeze(rows),
          summary,
        }),
      )
      setStatus(summary)
    } catch (cause: unknown) {
      if (validationRevision !== validationRevisionRef.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setStatus(`Calculation 재시도 실패 · ${message}`)
      toast.error(message)
    } finally {
      if (validationRevision === validationRevisionRef.current) {
        validationActiveRef.current = false
        ownedCalculationDataOperationRef.current = false
        setBusy(false)
        setValidating(false)
        setRetryingValidation(false)
      }
    }
  }, [contextExperimentMatches, experimentId, validation, workbench.calculationDataActions])

  useEffect(() => {
    if (!command) return
    if (command.type === 'settings') {
      setSetupDraft(setup)
      setSetupOpen(true)
    } else if (command.type === 'details') setDetailsOpen(true)
    else if (command.type === 'cancel') cancelCurrent()
    else void validatePrediction()
  }, [command?.id])

  const setupDraftError = useMemo(() => {
    if (!setupDraft.calculationIds.length) return 'Calculation을 하나 이상 선택하세요.'
    const weights = setupDraft.calculationIds.map((id) => setupDraft.calculationWeights[id] ?? 1)
    if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
      return 'Calculation weight는 유한한 0 이상의 수여야 합니다.'
    }
    if (!weights.some((weight) => weight > 0)) return 'Calculation weight 중 하나 이상은 양수여야 합니다.'
    if (
      setupDraft.kMode === 'manual' &&
      (!Number.isSafeInteger(setupDraft.manualK) ||
        setupDraft.manualK < 1 ||
        setupDraft.manualK > (context?.measurements.length ?? 0))
    ) {
      return `Manual k는 1..${(context?.measurements.length ?? 0).toLocaleString()} 범위의 정수여야 합니다.`
    }
    return null
  }, [context?.measurements.length, setupDraft])
  const setupDraftApplied = predictionFingerprint([setupDraft]) === predictionFingerprint([setup])

  const applySetup = useCallback(() => {
    if (freshnessPendingRef.current || dataStaleRef.current) return
    if (setupDraftError) {
      toast.error(setupDraftError)
      return
    }
    cancelCurrent()
    clientRef.current?.reset()
    setSetup(setupDraft)
    setSetupOpen(false)
    modelCacheRef.current = {}
    inverseRowsRef.current = null
    lastCandidateRef.current = currentCandidateFingerprint
    setSetupAppliedRevision((current) => current + 1)
  }, [cancelCurrent, currentCandidateFingerprint, setupDraft, setupDraftError])

  useEffect(() => {
    if (!setupAppliedRevision || !context) return
    if (direction === 'inverse') {
      if (setup.calculationIds.every((id) => calculationValues[id])) void runInverse(calculationValues)
      else {
        const missingIds = setup.calculationIds.filter((id) => !calculationValues[id])
        const reference = context.measurements.find((measurement) =>
          missingIds.every((id) =>
            context.analysis.items.some((item) => item.measurement_id === measurement.id && item.calculation_id === id),
          ),
        )
        if (reference) void loadReferenceMeasurement(reference.id, true)
        else {
          setCalculationErrors(
            Object.freeze(
              Object.fromEntries(missingIds.map((id) => [id, 'Target이 필요합니다. 저장된 Measurement를 불러오세요.'])),
            ),
          )
          setStatus('새 Calculation의 Target을 채울 compatible Measurement가 없습니다.')
        }
      }
    } else if (candidateVars) {
      void runForward(candidateVars)
    }
  }, [setupAppliedRevision])

  const calculateMissing = useCallback(async () => {
    if (
      busyRef.current ||
      freshnessPendingRef.current ||
      dataStaleRef.current ||
      !contextExperimentMatches ||
      workbench.measurementActions.busy ||
      workbench.calculationDataActions.busy
    )
      return
    const operationRevision = loadRevisionRef.current
    setSetupBusyAction('calculate-missing')
    setBusy(true)
    setStatus('Prediction cohort의 누락 CalculationData를 계산하는 중…')
    ownedCalculationDataOperationRef.current = true
    try {
      for (const calculationId of setupDraft.calculationIds) {
        const summary = await workbench.calculationDataActions.calculateSelected(calculationId)
        if (operationRevision !== loadRevisionRef.current || summary.cancelled) return
      }
      ownedCalculationDataOperationRef.current = false
      if (operationRevision !== loadRevisionRef.current) return
      await reloadData()
    } finally {
      ownedCalculationDataOperationRef.current = false
      setSetupBusyAction(null)
      if (operationRevision === loadRevisionRef.current) setBusy(false)
    }
  }, [
    contextExperimentMatches,
    reloadData,
    setupDraft.calculationIds,
    workbench.calculationDataActions,
    workbench.measurementActions.busy,
  ])

  const reloadFromSetup = useCallback(async () => {
    setSetupBusyAction('reload')
    try {
      await reloadData()
    } finally {
      setSetupBusyAction(null)
    }
  }, [reloadData])

  useEffect(() => {
    onChromeStateChange({
      busy,
      canValidate: validationDisabledReason === undefined,
      direction,
      status,
      validateDisabledReason: validationDisabledReason,
    })
  }, [busy, direction, onChromeStateChange, status, validationDisabledReason])

  const paneItems = useMemo<readonly PredictionCalculationPaneItem[]>(
    () =>
      selectedCalculations.map((calculation) => {
        const output = calculationValues[calculation.id] ?? null
        const validationSnapshotCurrent =
          validation?.direction === direction &&
          validation.experimentId === experimentId &&
          validation.candidateVarsFingerprint === currentCandidateFingerprint &&
          validation.setupFingerprint === predictionFingerprint([setup])
            ? validation
            : null
        const candidateValidationRow = validationSnapshotCurrent?.rows.find(
          (row) => row.calculationId === calculation.id,
        )
        const validationRow =
          output &&
          candidateValidationRow &&
          predictionFingerprint([candidateValidationRow.reference]) === predictionFingerprint([output])
            ? candidateValidationRow
            : null
        const repredictedOutput =
          direction === 'inverse'
            ? (validationSnapshotCurrent?.repredicted[calculation.id] ?? surrogateValues[calculation.id] ?? null)
            : null
        const repredictedMetric =
          output && repredictedOutput ? comparePredictionOutput(output, repredictedOutput) : null
        const repredictedStatus =
          direction !== 'inverse'
            ? 'unavailable'
            : repredictedOutput
              ? repredictedMetric?.compatible
                ? 'ready'
                : 'incompatible'
              : busy
                ? 'updating'
                : 'unavailable'
        const actualStatus =
          validating || retryingValidation
            ? 'updating'
            : validationRow?.error
              ? 'unavailable'
              : validationRow?.actual
                ? validationRow.metric?.compatible
                  ? 'ready'
                  : 'incompatible'
                : 'unavailable'
        const actualOutput = actualStatus === 'ready' ? validationRow?.actual : null
        const [minimum, maximum] = predictionOutputRange([
          output,
          repredictedStatus === 'ready' ? repredictedOutput : null,
          actualOutput,
        ])
        const [constraintMinimum, constraintMaximum] = output
          ? (integerRanges[output.dtype] ??
            (output.dtype === 'float32'
              ? [-3.402_823_466_385_288_6e38, 3.402_823_466_385_288_6e38]
              : [-Number.MAX_VALUE, Number.MAX_VALUE]))
          : [-Number.MAX_VALUE, Number.MAX_VALUE]
        return Object.freeze({
          actual: Object.freeze({
            error:
              validating || retryingValidation
                ? null
                : (validationRow?.error ?? validationRow?.metric?.message ?? null),
            metric: validationRow?.metric ?? null,
            output: actualOutput ?? null,
            snapshotKey: validationSnapshotCurrent?.snapshotFingerprint ?? null,
            status: actualStatus,
          }),
          calculationId: calculation.id,
          constraintMinimum,
          constraintMaximum,
          name: calculation.name,
          primary: Object.freeze({ output, role: direction === 'forward' ? 'predicted' : 'target' }),
          error: calculationErrors[calculation.id] ?? null,
          extrapolated:
            direction === 'inverse' &&
            Boolean(lastResult?.extrapolatedInputKeys.includes(`calculation:${calculation.id}`)),
          minimum,
          maximum,
          ...(direction === 'inverse'
            ? {
                repredicted: Object.freeze({
                  error:
                    repredictedStatus === 'incompatible'
                      ? repredictedMetric?.message
                      : (surrogateErrors[calculation.id] ?? null),
                  metric: repredictedMetric,
                  output: repredictedStatus === 'ready' ? repredictedOutput : null,
                  snapshotKey:
                    validationSnapshotCurrent?.snapshotFingerprint ?? `transaction:${transactionRef.current}`,
                  status: repredictedStatus,
                }),
              }
            : {}),
        })
      }),
    [
      busy,
      calculationErrors,
      calculationValues,
      currentCandidateFingerprint,
      direction,
      experimentId,
      lastResult,
      retryingValidation,
      selectedCalculations,
      setup,
      surrogateErrors,
      surrogateValues,
      validation,
      validating,
    ],
  )

  const validationText = validation
    ? [
        validation.summary,
        ...(validation.aggregateError === null
          ? []
          : [`Inverse normalized aggregate error: ${validation.aggregateError.toPrecision(7)}`]),
        ...validation.rows.map((row) => {
          const calculation = context?.calculations.find((item) => item.id === row.calculationId)
          if (row.error) return `${calculation?.name ?? `#${row.calculationId}`}: ${row.error}`
          if (!row.metric?.compatible) return `${calculation?.name ?? `#${row.calculationId}`}: ${row.metric?.message}`
          if (row.reference.shape.length === 0) {
            return `${calculation?.name ?? `#${row.calculationId}`}: Reference ${String(row.reference.data)}, Actual ${String(row.actual?.data)}, Abs ${row.metric.maxAbsoluteError?.toPrecision(5)}${row.metric.relativeError === null ? '' : `, Rel ${(row.metric.relativeError! * 100).toPrecision(5)}%`}`
          }
          return `${calculation?.name ?? `#${row.calculationId}`}: MAE ${row.metric.mae?.toPrecision(5)}, RMSE ${row.metric.rmse?.toPrecision(5)}, Max ${row.metric.maxAbsoluteError?.toPrecision(5)}`
        }),
      ].join('\n')
    : null

  const modelWarningText = useMemo(() => {
    const warnings: string[] = []
    if (profile && profile.rowCount < 3) {
      warnings.push(`신뢰도 경고: compatible Measurement가 ${profile.rowCount}개뿐입니다.`)
    }
    if (profile?.activeInputBlockCount === 0) {
      warnings.push('신뢰도 경고: 선택한 cohort의 모든 입력 component가 상수라 전체 cohort 평균을 사용합니다.')
    }
    if (lastResult?.extrapolatedInputKeys.length) {
      warnings.push(`학습 범위 밖 입력: ${lastResult.extrapolatedInputKeys.join(', ')}`)
    }
    if (lastResult?.constantInputKeysChanged.length) {
      warnings.push(`학습 cohort에서 상수였던 입력이 변경됨: ${lastResult.constantInputKeysChanged.join(', ')}`)
    }
    if (context && profile && workbench.experimentDocument.materialParameters) {
      const currentMaterial = predictionFingerprint([workbench.experimentDocument.materialParameters])
      const differentMaterials = context.measurements.filter(
        (measurement) =>
          profile.includedMeasurementIds.includes(measurement.id) &&
          predictionFingerprint([measurement.material_parameters]) !== currentMaterial,
      ).length
      if (differentMaterials > 0) {
        warnings.push(
          `Material은 모델 입력에서 제외됩니다. cohort 중 ${differentMaterials.toLocaleString()}개 Measurement의 Material snapshot이 현재 Candidate와 다릅니다.`,
        )
      }
    }
    return warnings.length ? warnings.join('\n') : null
  }, [context, lastResult, profile, workbench.experimentDocument.materialParameters])

  const varsPane = (
    <PredictionVarsPane
      candidateSessionKey={`${experimentId ?? 'none'}:${workbench.experimentDocument.candidateGeneration}:prediction`}
      direction={direction}
      disabled={validating || dataStale || freshnessPending || !varsSchema || !candidateVars}
      resetKey={currentCandidateFingerprint}
      schema={varsSchema}
      status={status}
      updating={busy}
      vars={candidateVars}
      onVariableChange={(key: string, value: Tensor) => {
        if (freshnessPendingRef.current || dataStaleRef.current) return
        if (!candidateVars) return
        const nextVars = Object.freeze({ ...candidateVars, [key]: value })
        if (candidateFingerprint(nextVars) === currentCandidateFingerprint) return
        if (!workbench.setCandidateVariables(nextVars, 'user-vars')) return
        referenceRevisionRef.current += 1
        transactionRef.current += 1
        calculationAbortRef.current?.abort()
        if (clientRef.current?.cancelPending()) modelCacheRef.current = {}
        setDirection('forward')
        setReferenceMeasurementId(null)
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setValidation(null)
        setSurrogateValues({})
        setSurrogateErrors({})
      }}
    />
  )

  if (!authenticated) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-medium">Prediction은 저장된 Measurement가 필요합니다.</p>
          <button className="mt-3 text-sm font-medium text-primary underline" type="button" onClick={onRequestLogin}>
            로그인
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {varsContainer ? createPortal(varsPane, varsContainer) : null}
      <PredictionCalculationPane
        disabled={validating || dataStale || freshnessPending}
        items={paneItems}
        mode={direction === 'forward' ? 'prediction' : 'target'}
        resetKey={`${experimentId ?? 'none'}:${calculationEditorRevision}`}
        referenceMeasurementId={referenceMeasurementId}
        referenceMeasurements={referenceMeasurements}
        status={status}
        updating={busy}
        onOutputChange={changeCalculationOutput}
        onReferenceMeasurementChange={(id) => void loadReferenceMeasurement(id)}
      />
      <PredictionSetupDialog
        applyDisabled={Boolean(setupDraftError) || dataStale || freshnessPending || validating}
        autoK={
          setupDraftApplied && profile?.rowCount
            ? Math.min(15, Math.max(1, Math.round(Math.sqrt(profile.rowCount))))
            : null
        }
        busyAction={setupBusyAction}
        calculateMissingDisabled={
          !setupDraft.calculationIds.length ||
          busy ||
          dataStale ||
          freshnessPending ||
          !contextExperimentMatches ||
          workbench.measurementActions.busy ||
          workbench.calculationDataActions.busy
        }
        calculations={
          contextExperimentMatches
            ? context.calculations.map((calculation) => ({
                id: calculation.id,
                name: calculation.name,
                description: calculation.description,
                missingCount: Math.max(
                  0,
                  (context.measurements.length ?? 0) -
                    new Set(
                      context.analysis.items
                        .filter((item) => item.calculation_id === calculation.id)
                        .map((item) => item.measurement_id),
                    ).size,
                ),
              }))
            : []
        }
        calculationWeights={setupDraft.calculationWeights}
        cohortSummary={
          setupDraftApplied && contextExperimentMatches ? cohortSummary(profile, context.measurements.length) : null
        }
        kMode={setupDraft.kMode}
        manualK={setupDraft.manualK}
        manualKMaximum={context?.measurements.length ?? 0}
        open={setupOpen}
        reloadDisabled={busy}
        selectedCalculationIds={setupDraft.calculationIds}
        validationMessage={
          setupDraftError ?? (dataStale ? '새 Measurement를 반영하려면 Reload Data가 필요합니다.' : null)
        }
        weighting={setupDraft.weighting}
        onApply={applySetup}
        onCalculateMissing={() => void calculateMissing()}
        onCalculationSelectedChange={(calculationId, selected) =>
          setSetupDraft((current) => {
            const calculationIds = selected
              ? [...current.calculationIds, calculationId]
              : current.calculationIds.filter((id) => id !== calculationId)
            return Object.freeze({
              ...current,
              calculationIds: Object.freeze([...new Set(calculationIds)]),
              calculationWeights: Object.freeze({
                ...current.calculationWeights,
                [calculationId]: current.calculationWeights[calculationId] ?? 1,
              }),
            })
          })
        }
        onCalculationWeightChange={(calculationId, weight) =>
          setSetupDraft((current) =>
            Object.freeze({
              ...current,
              calculationWeights: Object.freeze({ ...current.calculationWeights, [calculationId]: weight }),
            }),
          )
        }
        onCancel={() => setSetupOpen(false)}
        onKModeChange={(kMode) => setSetupDraft((current) => Object.freeze({ ...current, kMode }))}
        onManualKChange={(manualK) => setSetupDraft((current) => Object.freeze({ ...current, manualK }))}
        onOpenChange={setSetupOpen}
        onReload={() => void reloadFromSetup()}
        onWeightingChange={(weighting) => setSetupDraft((current) => Object.freeze({ ...current, weighting }))}
      />
      <PredictionDetailsDialog
        neighbors={neighbors}
        open={detailsOpen}
        profile={profile}
        resultText={modelWarningText}
        retryCalculationsDisabled={
          busy ||
          freshnessPending ||
          !contextExperimentMatches ||
          validation?.experimentId !== experimentId ||
          !validation?.rows.some((row) => row.error)
        }
        retryingCalculations={retryingValidation}
        validationComparisons={
          validation?.rows.map((row) => ({
            actual: row.actual,
            calculationId: row.calculationId,
            direction: validation.direction,
            error: row.error,
            metric: row.metric,
            name:
              context?.calculations.find((calculation) => calculation.id === row.calculationId)?.name ??
              `#${row.calculationId}`,
            repredicted: validation.repredicted[row.calculationId] ?? null,
            reference: row.reference,
          })) ?? []
        }
        validationText={validationText}
        onOpenChange={setDetailsOpen}
        onRetryCalculations={validation ? () => void retryValidationCalculations() : undefined}
      />
    </>
  )
}
