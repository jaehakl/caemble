import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import {
  dbTables,
  getListRequest,
  type AvailableExperimentRecord,
  type CalculationDataAnalysisResponse,
  type CalculationDataOutput,
  type CalculationOutputLayout,
  type CalculationDataRecord,
  type CalculationRecord,
  type ExperimentRecordedDataRecord,
  type MeasurementRecord,
  type RecordedDataRecord,
} from '@/api'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { calculationSourceHash, runCalculation } from '@/lib/calculation'
import type { Tensor, Vars, VarsSchemaEntry } from '@/lib/cad'
import type { CaeWorkbenchState } from '../state/useCaeWorkbenchState'
import { buildCalculationRecordedData } from '../calculation/calculationRecordedData'
import { compatibleVarsResetValues, varsTensorFromFlat } from '../calculation/varsTensor'
import { recordedDataRules } from '../measurement/recordedData'
import { PredictionWorkerClient, PredictionWorkerRestartError } from './client'
import {
  calculationOutputSample,
  inverseTrainingRows,
  predictedRecordedData,
  predictionFingerprint,
  predictionRecordedRowSample,
  predictionVarsLayouts,
  predictionVarsSamples,
} from './data'
import { emitPredictionCohortDiagnostics, emitPredictionQueryDiagnostics } from './diagnostics'
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
  PredictionNumericDtype,
  PredictionResult,
  PredictionTensorLayout,
  PredictionTrainingRow,
  PredictionWeighting,
} from './knn'
import type { PredictionWorkerModelProfile } from './protocol'
import type { PredictionSamplingRange } from './sampling'

type SavedCalculation = CalculationRecord & Readonly<{ id: number }>
type SavedMeasurement = MeasurementRecord & Readonly<{ id: number }>
type VarsSchema = Readonly<Record<string, VarsSchemaEntry>>

export type PredictionWorkspaceCommand = Readonly<{
  id: number
  type: 'settings' | 'details' | 'validate' | 'sample' | 'cancel'
  sampleCount?: number
}>

export type PredictionWorkspaceChromeState = Readonly<{
  busy: boolean
  canSample: boolean
  canValidate: boolean
  direction: PredictionDirection
  status: string
  sampleDisabledReason?: string
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
  experimentRecords: readonly ExperimentRecordedDataRecord[]
  measurements: readonly SavedMeasurement[]
}>

type ModelCache = Readonly<{
  fingerprint: string
  generation: number
  profile: PredictionWorkerModelProfile
  workerEpoch: number
}>

type SamplingProgress = Readonly<{
  attempt: number
  failures: number
  phase: 'candidate' | 'simulation' | 'stopping'
  recorded: number
  sessionId: string
  successes: number
  total: number
}>

type ForwardModelEntry = ModelCache &
  Readonly<{
    record: ExperimentRecordedDataRecord
    rule: ReturnType<typeof recordedDataRules>[number]
  }>

type ForwardModelBundle = Readonly<{
  errors: Readonly<Record<number, string>>
  fingerprint: string
  models: readonly ForwardModelEntry[]
  profile: PredictionWorkerModelProfile
  rules: ReturnType<typeof recordedDataRules>
}>

type ForwardRecordProfile = Readonly<{
  error: string | null
  name: string
  profile: PredictionWorkerModelProfile | null
  recordId: number
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
  primaryRevision: number
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

function calculationOutputLayout(output: CalculationDataOutput | CalculationOutputLayout) {
  return Object.freeze({
    dtype: output.dtype,
    shape: Object.freeze([...output.shape]),
    axes: Object.freeze(
      output.axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ticks: Object.freeze([...axis.ticks]),
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
}

function calculationPlaceholder(layout: CalculationOutputLayout): CalculationDataOutput {
  const size = layout.shape.reduce((total, length) => total * length, 1)
  return Object.freeze({
    dtype: layout.dtype,
    shape: Object.freeze([...layout.shape]),
    data: layout.shape.length === 0 ? 0 : Object.freeze(Array.from({ length: size }, () => 0)),
    axes: Object.freeze(
      layout.axes.map((axis) =>
        Object.freeze({
          name: axis.name,
          ticks: Object.freeze([...axis.ticks]),
          ...(axis.unit ? { unit: axis.unit } : {}),
        }),
      ),
    ),
  })
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
    warningMeasurementIds: profile.warningMeasurementIds,
    dominantShapeSignature: profile.dominantShapeSignature,
    baselineMeasurementId: profile.baselineMeasurementId,
    diagnostics: profile.diagnostics,
    omittedDiagnosticGroups: profile.omittedDiagnosticGroups,
    excluded: profile.excluded,
  })
}

function aggregateForwardProfiles(models: readonly ForwardModelEntry[]): PredictionWorkerModelProfile {
  const profiles = models.map((model) => model.profile)
  const excluded = {
    'missing-block': 0,
    'extra-block': 0,
    'invalid-tensor': 0,
    'fixed-layout-mismatch': 0,
    'layout-mismatch': 0,
  }
  profiles.forEach((profile) => {
    ;(Object.keys(excluded) as (keyof typeof excluded)[]).forEach((reason) => {
      excluded[reason] += profile.excluded[reason]
    })
  })
  const diagnostics = profiles.flatMap((profile) => profile.diagnostics)
  return Object.freeze({
    direction: 'forward' as const,
    activeInputBlockCount: profiles[0]?.activeInputBlockCount ?? 0,
    rowCount: Math.min(...profiles.map((profile) => profile.rowCount)),
    k: Math.min(...profiles.map((profile) => profile.k)),
    weighting: profiles[0]?.weighting ?? 'distance',
    inputScaling: 'range' as const,
    inputLayouts: Object.freeze([]),
    inputScales: new Float64Array(),
    inputBlockWeights: profiles[0]?.inputBlockWeights ?? Object.freeze({}),
    inputSize: profiles[0]?.inputSize ?? 0,
    outputSize: profiles.reduce((total, profile) => total + profile.outputSize, 0),
    persistentBytes: profiles.reduce((total, profile) => total + profile.persistentBytes, 0),
    workingSetBytes: profiles.reduce((total, profile) => total + profile.workingSetBytes, 0),
    includedMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.includedMeasurementIds))].sort((left, right) => left - right),
    ),
    warningMeasurementIds: Object.freeze(
      [...new Set(profiles.flatMap((profile) => profile.warningMeasurementIds))].sort((left, right) => left - right),
    ),
    dominantShapeSignature: JSON.stringify(
      Object.fromEntries(models.map((model) => [model.record.name, JSON.parse(model.profile.dominantShapeSignature)])),
    ),
    baselineMeasurementId: Math.min(...profiles.map((profile) => profile.baselineMeasurementId)),
    diagnostics: Object.freeze(diagnostics.slice(0, 500)),
    omittedDiagnosticGroups:
      profiles.reduce((total, profile) => total + profile.omittedDiagnosticGroups, 0) +
      Math.max(0, diagnostics.length - 500),
    excluded: Object.freeze(excluded),
  })
}

export function PredictionWorkspace({
  active,
  authenticated,
  dataReadable,
  command,
  onActivity,
  onChromeStateChange,
  onExperimentChange,
  onRequestLogin,
  selectedCalculationId,
  varsContainer,
  workbench,
}: {
  active: boolean
  authenticated: boolean
  dataReadable: boolean
  command: PredictionWorkspaceCommand | null
  onActivity?: RuntimeActivityCallback
  onChromeStateChange: (state: PredictionWorkspaceChromeState) => void
  onExperimentChange: (experiment: AvailableExperimentRecord) => void
  onRequestLogin: () => void
  selectedCalculationId: number | null
  varsContainer: HTMLDivElement | null
  workbench: CaeWorkbenchState
}) {
  const clientRef = useRef<PredictionWorkerClient | null>(null)
  const generationRef = useRef(0)
  const loadRevisionRef = useRef(0)
  const autoLoadAttemptRef = useRef<string | null>(null)
  const primaryRevisionRef = useRef(0)
  const transactionRef = useRef(0)
  const validationRevisionRef = useRef(0)
  const validationActiveRef = useRef(false)
  const samplingRevisionRef = useRef(0)
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
  const forwardModelCacheRef = useRef<ForwardModelBundle | null>(null)
  const emittedDiagnosticFingerprintsRef = useRef(new Set<string>())
  const userChangedVarsRef = useRef(false)
  const inverseRowsRef = useRef<Readonly<{ key: string; rows: readonly PredictionTrainingRow[] }> | null>(null)
  const cancelMeasurementRef = useRef(workbench.measurementActions.cancel)
  const cancelCalculationDataRef = useRef(workbench.calculationDataActions.cancel)
  const [forwardRecordProfiles, setForwardRecordProfiles] = useState<readonly ForwardRecordProfile[]>([])
  const clearModelCaches = useCallback(() => {
    modelCacheRef.current = {}
    forwardModelCacheRef.current = null
    setForwardRecordProfiles([])
  }, [])

  const [context, setContext] = useState<PredictionContext | null>(null)
  const contextRef = useRef(context)
  const [setup, setSetup] = useState<PredictionSetup>(defaultSetup)
  const [setupDraft, setSetupDraft] = useState<PredictionSetup>(defaultSetup)
  const [setupAppliedRevision, setSetupAppliedRevision] = useState(0)
  const [setupOpen, setSetupOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [detailsDirection, setDetailsDirection] = useState<PredictionDirection>('forward')
  const [setupBusyAction, setSetupBusyAction] = useState<PredictionSetupBusyAction>(null)
  const [direction, setDirection] = useState<PredictionDirection>('forward')
  const [guideProgress, setGuideProgress] = useState(() => {
    try {
      const complete = sessionStorage.getItem('caemble.prediction-guide-complete') === '1'
      return { forward: complete, inverse: complete }
    } catch {
      return { forward: false, inverse: false }
    }
  })
  const [status, setStatus] = useState('Prediction 데이터를 준비하세요.')
  const [busy, setBusy] = useState(false)
  const [validating, setValidating] = useState(false)
  const [retryingValidation, setRetryingValidation] = useState(false)
  const [dataStale, setDataStaleState] = useState(false)
  const [freshnessPending, setFreshnessPendingState] = useState(true)
  const [calculationValues, setCalculationValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [calculationPrimaryRevision, setCalculationPrimaryRevision] = useState(0)
  const [calculationErrors, setCalculationErrors] = useState<Readonly<Record<number, string>>>({})
  const [surrogateValues, setSurrogateValues] = useState<Readonly<Record<number, CalculationDataOutput>>>({})
  const [surrogateErrors, setSurrogateErrors] = useState<Readonly<Record<number, string>>>({})
  const [neighborsByDirection, setNeighborsByDirection] = useState<
    Partial<Record<PredictionDirection, readonly PredictionNeighbor[]>>
  >({})
  const [profiles, setProfiles] = useState<Partial<Record<PredictionDirection, PredictionWorkerModelProfile>>>({})
  const [lastResult, setLastResult] = useState<PredictionResult | null>(null)
  const [forwardVarsFingerprint, setForwardVarsFingerprint] = useState<string | null>(null)
  const [inverseVarsFingerprint, setInverseVarsFingerprint] = useState<string | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [samplingProgress, setSamplingProgress] = useState<SamplingProgress | null>(null)
  const samplingProgressRef = useRef(samplingProgress)
  const [samplingRanges, setSamplingRanges] = useState<Readonly<Record<string, PredictionSamplingRange>>>({})
  const calculationValuesRef = useRef(calculationValues)
  const busyRef = useRef(busy)
  calculationValuesRef.current = calculationValues
  busyRef.current = busy
  samplingProgressRef.current = samplingProgress
  cancelMeasurementRef.current = workbench.measurementActions.cancel
  cancelCalculationDataRef.current = workbench.calculationDataActions.cancel

  const experimentId = workbench.experimentId
  const experimentIdRef = useRef(experimentId)
  const availableQuery = useQuery({
    queryKey: ['experiment', 'available', authenticated],
    queryFn: dbTables.Experiment.available,
  })
  const contextExperimentMatches = context?.experimentId === experimentId
  const varsSchema = workbench.experimentDocument.varsSchema as VarsSchema | null
  const candidateVars = workbench.candidateVars
  const currentCandidateFingerprint = candidateFingerprint(candidateVars)
  const profile = profiles[direction] ?? null
  const candidateFingerprintRef = useRef(currentCandidateFingerprint)
  const candidateVarsRef = useRef(candidateVars)
  const experimentDocumentRef = useRef(workbench.experimentDocument)
  const measurementActionsRef = useRef(workbench.measurementActions)
  const setCandidateVariablesRef = useRef(workbench.setCandidateVariables)
  const sourceIdentity = predictionFingerprint([
    experimentId,
    workbench.experiment?.sourceBundle.files ?? null,
    workbench.experimentRecord?.source_hash ?? null,
  ])
  const sourceIdentityRef = useRef(sourceIdentity)
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
  candidateVarsRef.current = candidateVars
  experimentDocumentRef.current = workbench.experimentDocument
  measurementActionsRef.current = workbench.measurementActions
  setCandidateVariablesRef.current = workbench.setCandidateVariables
  sourceIdentityRef.current = sourceIdentity

  const samplingRangeResetKey = predictionFingerprint([
    experimentId,
    Object.entries(varsSchema ?? {}).map(([key, entry]) => [key, entry.shape, entry.min, entry.max]),
  ])
  const defaultSamplingRanges = useMemo(
    () =>
      Object.freeze(
        Object.fromEntries(
          Object.entries(varsSchema ?? {}).map(([key, entry]) => [
            key,
            Object.freeze({ min: entry.min, max: entry.max }),
          ]),
        ),
      ),
    [samplingRangeResetKey],
  )
  useEffect(() => setSamplingRanges(defaultSamplingRanges), [defaultSamplingRanges, samplingRangeResetKey])
  const effectiveSamplingRanges =
    Object.keys(samplingRanges).length === Object.keys(defaultSamplingRanges).length
      ? samplingRanges
      : defaultSamplingRanges
  const resetValues = useMemo(
    () =>
      compatibleVarsResetValues(
        contextExperimentMatches
          ? context.measurements.flatMap((measurement) =>
              measurement.vars ? [measurement.vars as Readonly<Vars>] : [],
            )
          : [],
        varsSchema ?? {},
      ),
    [context, contextExperimentMatches, varsSchema],
  )

  useEffect(() => {
    if (!guideProgress.forward || !guideProgress.inverse) return
    try {
      sessionStorage.setItem('caemble.prediction-guide-complete', '1')
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
  }, [guideProgress])

  const setFreshnessPending = useCallback((pending: boolean) => {
    freshnessPendingRef.current = pending
    setFreshnessPendingState(pending)
  }, [])
  const setDataStale = useCallback((stale: boolean) => {
    dataStaleRef.current = stale
    setDataStaleState(stale)
  }, [])

  const rememberProfile = useCallback(
    (next: PredictionWorkerModelProfile, fingerprint: string) => {
      setProfiles((current) => ({ ...current, [next.direction]: next }))
      emitPredictionCohortDiagnostics(next, fingerprint, emittedDiagnosticFingerprintsRef.current, onActivity)
    },
    [onActivity],
  )

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
    samplingRevisionRef.current += 1
    primaryRevisionRef.current += 1
    calculationAbortRef.current?.abort()
    calculationAbortRef.current = null
    if (ownedCalculationDataOperationRef.current) cancelCalculationDataRef.current()
    ownedCalculationDataOperationRef.current = false
    const predictionCanceled = clientRef.current?.cancelPending() ?? false
    if (predictionCanceled) clearModelCaches()
    if (validationActiveRef.current) {
      cancelMeasurementRef.current()
      if (!predictionCanceled) clientRef.current?.reset()
      clearModelCaches()
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setDataStale(true)
    }
    validationActiveRef.current = false
    if (samplingProgressRef.current) {
      cancelMeasurementRef.current()
      if (!predictionCanceled) clientRef.current?.reset()
      clearModelCaches()
      if (samplingProgressRef.current.recorded > 0) setFreshnessPending(true)
      setSamplingProgress(null)
    }
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

  const reloadData = useCallback(
    async (options: Readonly<{ automatic?: boolean; preserveValidation?: boolean }> = {}) => {
      if (!dataReadable || experimentId === null) {
        setContext(null)
        setStatus(
          experimentId === null
            ? 'Prediction 가능한 Experiment를 선택하세요.'
            : '이 Experiment의 데이터를 읽을 수 없습니다.',
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
        const [calculationResponse, measurementResponse, experimentRecordResponse, analysis] = await Promise.all([
          dbTables.Calculation.listRows(listRequest),
          dbTables.Measurement.listRows(listRequest),
          dbTables.ExperimentRecord.listRows({ ...listRequest, experiment_id: experimentId }),
          dbTables.CalculationData.analysis(experimentId),
        ])
        if (revision !== loadRevisionRef.current) return
        transactionRef.current += 1
        primaryRevisionRef.current += 1
        calculationAbortRef.current?.abort()
        calculationAbortRef.current = null
        clientRef.current?.reset()
        const calculations = calculationResponse.items.filter(
          (row): row is SavedCalculation => typeof row.id === 'number',
        )
        const measurements = measurementResponse.items.filter(
          (row): row is SavedMeasurement => typeof row.id === 'number' && row.recorded_at !== null,
        )
        const experimentRecords = Object.freeze(experimentRecordResponse.items)
        const readyCalculations = calculations.filter(
          (row) => row.contract_status === 'ready' && row.output_layout && row.source_hash,
        )
        const fingerprint = predictionFingerprint([
          experimentId,
          analysis.fingerprint,
          measurements.map((row) => [row.id, row.updated_at, row.recorded_at]),
          experimentRecords.map((record) => [record.id, record.contract_hash]),
          calculations.map((row) => [
            row.id,
            row.updated_at,
            row.source_hash,
            row.output_layout,
            row.experiment_record_ids,
            row.contract_status,
          ]),
        ])
        setContext(
          Object.freeze({
            analysis,
            calculations: Object.freeze(calculations),
            experimentId,
            experimentRecords,
            fingerprint,
            measurements: Object.freeze(measurements),
          }),
        )
        clearModelCaches()
        inverseRowsRef.current = null
        setProfiles({})
        setNeighborsByDirection({})
        setLastResult(null)
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setSurrogateValues({})
        setSurrogateErrors({})
        setCalculationErrors({})
        setDataStale(false)
        setFreshnessPending(false)
        skipNextPredictionBusyCheckRef.current = true
        if (!options.preserveValidation) setValidation(null)
        lastCandidateRef.current = currentCandidateFingerprint
        setSetup((current) => {
          const valid = current.calculationIds.filter((id) => readyCalculations.some((row) => row.id === id))
          const fallback =
            valid.length > 0
              ? valid
              : [
                  selectedCalculationId && readyCalculations.some((row) => row.id === selectedCalculationId)
                    ? selectedCalculationId
                    : readyCalculations[0]?.id,
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
          const valid = current.calculationIds.filter((id) => readyCalculations.some((row) => row.id === id))
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
        if (options.automatic) setDataStale(true)
        setFreshnessPending(false)
        toast.error(message)
      } finally {
        if (revision === loadRevisionRef.current) setBusy(false)
      }
    },
    [
      dataReadable,
      cancelCurrent,
      currentCandidateFingerprint,
      experimentId,
      selectedCalculationId,
      setFreshnessPending,
      setDataStale,
    ],
  )

  useLayoutEffect(() => {
    validationRevisionRef.current += 1
    validationActiveRef.current = false
    clientRef.current?.reset()
    clearModelCaches()
    inverseRowsRef.current = null
    setContext(null)
    setValidation(null)
    setDetailsOpen(false)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationPrimaryRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setDirection('forward')
    setProfiles({})
    setNeighborsByDirection({})
    lastCandidateRef.current = 'none'
    if (active) {
      autoLoadAttemptRef.current = `${dataReadable}:${experimentId ?? 'none'}`
      void reloadData()
    }
  }, [experimentId])

  useEffect(() => {
    const loadKey = `${dataReadable}:${experimentId ?? 'none'}`
    if (!active || !dataReadable || context || busy || autoLoadAttemptRef.current === loadKey) return
    autoLoadAttemptRef.current = loadKey
    void reloadData()
  }, [active, busy, context, dataReadable, experimentId, reloadData])

  useEffect(() => {
    if (dataReadable) return
    autoLoadAttemptRef.current = null
    loadRevisionRef.current += 1
    cancelCurrent()
    clientRef.current?.reset()
    clearModelCaches()
    inverseRowsRef.current = null
    setContext(null)
    calculationValuesRef.current = {}
    setCalculationValues({})
    setCalculationPrimaryRevision((current) => current + 1)
    setCalculationErrors({})
    setSurrogateValues({})
    setSurrogateErrors({})
    setProfiles({})
    setNeighborsByDirection({})
    setLastResult(null)
    setForwardVarsFingerprint(null)
    setInverseVarsFingerprint(null)
    setStatus('Prediction 가능한 Experiment를 선택하세요.')
  }, [cancelCurrent, dataReadable])

  const checkDataFingerprint = useCallback(async () => {
    if (!dataReadable || experimentId === null || !context || context.experimentId !== experimentId || busyRef.current)
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
      const [calculationResponse, measurementResponse, experimentRecordResponse, analysisStatus] = await Promise.all([
        dbTables.Calculation.listRows(listRequest),
        dbTables.Measurement.listRows(listRequest),
        dbTables.ExperimentRecord.listRows({ ...listRequest, experiment_id: experimentId }),
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
        experimentRecordResponse.items.map((record) => [record.id, record.contract_hash]),
        calculations.map((row) => [
          row.id,
          row.updated_at,
          row.source_hash,
          row.output_layout,
          row.experiment_record_ids,
          row.contract_status,
        ]),
      ])
      if (fingerprint !== context.fingerprint) {
        setStatus('Measurement 또는 Calculation 변경 감지 · 모델을 자동 갱신하는 중…')
        await reloadData({ automatic: true, preserveValidation: true })
        return
      }
      setFreshnessPending(false)
    } catch {
      if (
        checkRevision === checkingFingerprintRef.current &&
        loadRevision === loadRevisionRef.current &&
        experimentIdRef.current === experimentId &&
        contextRef.current === context
      ) {
        setDataStale(true)
        setFreshnessPending(false)
        setStatus('Prediction 데이터 최신성을 확인하지 못했습니다. Reload Data를 실행하세요.')
      }
    }
  }, [context, dataReadable, experimentId, reloadData, setFreshnessPending])

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
    async (transaction: number): Promise<ForwardModelBundle> => {
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      if (!context || context.experimentId !== experimentId || !varsSchema || !clientRef.current)
        throw new Error('Forward 모델 context가 준비되지 않았습니다.')
      const requiredRecordIds = Object.freeze(
        [...new Set(selectedCalculations.flatMap((calculation) => calculation.experiment_record_ids))].sort(
          (left, right) => left - right,
        ),
      )
      if (!requiredRecordIds.length) throw new Error('선택한 Calculation이 사용하는 ExperimentRecord가 없습니다.')
      const records = requiredRecordIds.map((recordId) => {
        const record = context.experimentRecords.find((candidate) => candidate.id === recordId)
        if (!record) throw new Error(`ExperimentRecord #${recordId} 계약을 찾을 수 없습니다.`)
        return record
      })
      const currentRules = recordedDataRules(
        workbench.experimentDocument.simulationProgram?.recordedData ?? Object.freeze({}),
        'prediction.forward',
      )
      const rulesByName = new Map(currentRules.map((rule) => [rule.label, rule]))
      const fingerprint = predictionFingerprint([
        context.fingerprint,
        'forward-by-experiment-record',
        setup.kMode === 'manual' ? setup.manualK : 'auto',
        setup.weighting,
        predictionVarsLayouts(varsSchema),
        records.map((record) => [record.id, record.contract_hash]),
      ])
      const cached = forwardModelCacheRef.current
      if (
        cached?.fingerprint === fingerprint &&
        cached.models.every((model) => model.workerEpoch === clientRef.current!.epoch)
      ) {
        return cached
      }

      const recordedResponse = await dbTables.RecordedData.listRows({
        ...getListRequest('visible'),
        experiment_id: experimentId,
        experiment_record_ids: requiredRecordIds,
        limit: null,
        sort: ['measurement_id', 'asc'],
      })
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      const measurementIds = new Set(context.measurements.map((measurement) => measurement.id))
      const rowsByRecord = new Map<number, Map<number, RecordedDataRecord>>()
      recordedResponse.items.forEach((row) => {
        if (!measurementIds.has(row.measurement_id) || !requiredRecordIds.includes(row.experiment_record_id)) return
        const byMeasurement = rowsByRecord.get(row.experiment_record_id) ?? new Map<number, RecordedDataRecord>()
        byMeasurement.set(row.measurement_id, row)
        rowsByRecord.set(row.experiment_record_id, byMeasurement)
      })

      const models: ForwardModelEntry[] = []
      const errors: Record<number, string> = {}
      for (const record of records) {
        const rule = rulesByName.get(record.name)
        if (!rule) {
          errors[record.id] = `현재 Experiment source에서 ${record.name} Record를 찾을 수 없습니다.`
          continue
        }
        if (rule.result.dtype === 'bool' || rule.result.dtype === 'string') {
          errors[record.id] = `${record.name}의 dtype ${rule.result.dtype}은 numeric Prediction을 지원하지 않습니다.`
          continue
        }
        const byMeasurement = rowsByRecord.get(record.id) ?? new Map<number, RecordedDataRecord>()
        const rows = Object.freeze(
          context.measurements.map((measurement): PredictionTrainingRow => {
            try {
              const inputs = predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)
              const stored = byMeasurement.get(measurement.id)
              if (!stored) return Object.freeze({ measurementId: measurement.id, inputs, outputs: Object.freeze([]) })
              try {
                return Object.freeze({
                  measurementId: measurement.id,
                  inputs,
                  outputs: Object.freeze([predictionRecordedRowSample(stored)]),
                })
              } catch {
                return Object.freeze({
                  measurementId: measurement.id,
                  inputs,
                  outputs: Object.freeze([
                    Object.freeze({
                      layout: Object.freeze({ key: record.name, dtype: 'float64' as const, shape: Object.freeze([]) }),
                      values: Object.freeze([Number.NaN]),
                    }),
                  ]),
                })
              }
            } catch {
              return Object.freeze({
                measurementId: measurement.id,
                inputs: Object.freeze([]),
                outputs: Object.freeze([]),
              })
            }
          }),
        )
        try {
          assertTrainingCellLimit(rows)
          const modelFingerprint = predictionFingerprint([fingerprint, record.id, record.contract_hash])
          const generation = ++generationRef.current
          const profile = await clientRef.current.build(`forward:${record.id}`, generation, modelFingerprint, {
            direction: 'forward',
            fingerprint: modelFingerprint,
            inputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
            outputKeys: [record.name],
            outputDtypes: Object.freeze({ [record.name]: rule.result.dtype as PredictionNumericDtype }),
            rows,
            diagnoseMetadata: false,
            fixedInputLayouts: predictionVarsLayouts(varsSchema),
            inputScaling: 'range',
            weighting: setup.weighting,
            ...(setup.kMode === 'manual' ? { k: setup.manualK } : {}),
          })
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          emitPredictionCohortDiagnostics(
            profile,
            modelFingerprint,
            emittedDiagnosticFingerprintsRef.current,
            onActivity,
          )
          models.push(
            Object.freeze({
              fingerprint: modelFingerprint,
              generation,
              profile,
              record,
              rule,
              workerEpoch: clientRef.current.epoch,
            }),
          )
        } catch (cause: unknown) {
          if ((cause as { name?: string })?.name === 'AbortError' || cause instanceof PredictionWorkerRestartError)
            throw cause
          errors[record.id] = cause instanceof Error ? cause.message : String(cause)
        }
      }
      setForwardRecordProfiles(
        Object.freeze(
          records.map((record) => {
            const model = models.find((candidate) => candidate.record.id === record.id)
            return Object.freeze({
              error: errors[record.id] ?? null,
              name: record.name,
              profile: model?.profile ?? null,
              recordId: record.id,
            })
          }),
        ),
      )
      if (!models.length) throw new Error(Object.values(errors)[0] ?? '사용 가능한 ExperimentRecord 모델이 없습니다.')
      const profile = aggregateForwardProfiles(models)
      const next = Object.freeze({
        errors: Object.freeze(errors),
        fingerprint,
        models: Object.freeze(models),
        profile,
        rules: Object.freeze(models.map((model) => model.rule)),
      })
      forwardModelCacheRef.current = next
      rememberProfile(profile, fingerprint)
      return next
    },
    [
      context,
      experimentId,
      onActivity,
      rememberProfile,
      selectedCalculations,
      setup.kMode,
      setup.manualK,
      setup.weighting,
      varsSchema,
      workbench.experimentDocument.simulationProgram?.recordedData,
    ],
  )

  const fetchSelectedCalculationData = useCallback(
    async (transaction?: number) => {
      if (!context || experimentId === null || context.experimentId !== experimentId)
        throw new Error('CalculationData context가 없습니다.')
      const ids = context.analysis.items
        .filter((item) => setup.calculationIds.includes(item.calculation_id))
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
        const records = await fetchSelectedCalculationData(transaction)
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
      const fixedInputLayouts = Object.freeze(
        setup.calculationIds.map((id) => {
          const calculation = selectedCalculations.find((candidate) => candidate.id === id)
          if (!calculation?.output_layout) throw new Error(`Calculation #${id}의 Output 계약이 없습니다.`)
          return Object.freeze({
            key: `calculation:${id}`,
            dtype: calculation.output_layout.dtype as PredictionNumericDtype,
            shape: Object.freeze([...calculation.output_layout.shape]),
            axes: Object.freeze(
              calculation.output_layout.axes.map((axis) =>
                Object.freeze({
                  name: axis.name,
                  ticks: Object.freeze([...axis.ticks]),
                  ...(axis.unit ? { unit: axis.unit } : {}),
                }),
              ),
            ),
          })
        }),
      )
      const profile = await clientRef.current
        .build('inverse', generation, fingerprint, {
          direction: 'inverse',
          fingerprint,
          inputKeys: setup.calculationIds.map((id) => `calculation:${id}`),
          outputKeys: predictionVarsLayouts(varsSchema).map((layout) => layout.key),
          rows,
          fixedInputLayouts,
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
      rememberProfile(profile, fingerprint)
      modelCacheRef.current = { ...modelCacheRef.current, inverse: next }
      return next
    },
    [context, experimentId, fetchSelectedCalculationData, rememberProfile, selectedCalculations, setup, varsSchema],
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
          if (calculation.contract_status !== 'ready' || !calculation.output_layout) {
            throw new Error('Calculation preflight 계약이 준비되지 않았습니다.')
          }
          const requiredNames = calculation.experiment_record_ids.map((recordId) => {
            const name = context?.experimentRecords.find((record) => record.id === recordId)?.name
            if (!name) throw new Error(`ExperimentRecord #${recordId} 계약을 찾을 수 없습니다.`)
            return name
          })
          const calculationInput = Object.freeze(
            Object.fromEntries(
              requiredNames.map((name) => {
                const value = input[name]
                if (!value) throw new Error(`예측할 수 있는 ${name} RecordedData가 없습니다.`)
                return [name, value]
              }),
            ),
          )
          const output = await runCalculation({
            input: calculationInput,
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
          if (
            predictionFingerprint([calculationOutputLayout(output)]) !==
            predictionFingerprint([calculationOutputLayout(calculation.output_layout)])
          ) {
            throw new Error('Calculation 결과 layout이 저장된 preflight 계약과 다릅니다.')
          }
          values[calculation.id] = output
        } catch (cause: unknown) {
          if (!controller.signal.aborted)
            errors[calculation.id] = cause instanceof Error ? cause.message : String(cause)
        }
      })
      if (transaction !== transactionRef.current) throw new DOMException('Stale Prediction transaction', 'AbortError')
      return Object.freeze({ values: Object.freeze(values), errors: Object.freeze(errors) })
    },
    [context?.experimentRecords, onActivity, selectedCalculations],
  )

  const forwardOutputs = useCallback(
    async (vars: Readonly<Vars>, transaction: number) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const model = await ensureForwardModel(transaction)
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const query = predictionVarsSamples(vars, varsSchema!)
          const results = await Promise.all(
            model.models.map(async (entry) => {
              const result = await clientRef.current!.predict(
                `forward:${entry.record.id}`,
                entry.generation,
                entry.fingerprint,
                query,
              )
              emitPredictionQueryDiagnostics(
                result,
                entry.fingerprint,
                emittedDiagnosticFingerprintsRef.current,
                onActivity,
              )
              return result
            }),
          )
          if (transaction !== transactionRef.current)
            throw new DOMException('Stale Prediction transaction', 'AbortError')
          const neighborMap = new Map<number, { distanceSquared: number; weight: number }>()
          results.forEach((result) =>
            result.neighbors.forEach((neighbor) => {
              const current = neighborMap.get(neighbor.measurementId)
              neighborMap.set(neighbor.measurementId, {
                distanceSquared: Math.min(
                  current?.distanceSquared ?? Number.POSITIVE_INFINITY,
                  neighbor.distanceSquared,
                ),
                weight: (current?.weight ?? 0) + neighbor.weight / results.length,
              })
            }),
          )
          const result: PredictionResult = Object.freeze({
            direction: 'forward',
            fingerprint: model.fingerprint,
            output: Object.freeze(results.flatMap((entry) => entry.output)),
            neighbors: Object.freeze(
              [...neighborMap.entries()]
                .map(([measurementId, neighbor]) => Object.freeze({ measurementId, ...neighbor }))
                .sort((left, right) => right.weight - left.weight || left.measurementId - right.measurementId),
            ),
            extrapolatedInputKeys: Object.freeze(
              [...new Set(results.flatMap((entry) => entry.extrapolatedInputKeys))].sort(),
            ),
            constantInputKeysChanged: Object.freeze(
              [...new Set(results.flatMap((entry) => entry.constantInputKeysChanged))].sort(),
            ),
            queryDiagnostics: Object.freeze(results.flatMap((entry) => entry.queryDiagnostics)),
          })
          const recorded = predictedRecordedData(result.output, model.rules, (warning) => {
            const key = `axis-fallback:${model.fingerprint}:${warning.blockKey}:${warning.axisIndex}`
            if (emittedDiagnosticFingerprintsRef.current.has(key)) return
            emittedDiagnosticFingerprintsRef.current.add(key)
            onActivity?.({
              source: 'prediction',
              level: 'warning',
              phase: 'cohort.forward',
              message: `[Forward output] ${warning.blockKey} axis ${warning.axisIndex}의 ticks를 사용할 수 없어 ${warning.length.toLocaleString()}개 ordinal ticks로 대체했습니다.`,
              details: {
                block: warning.blockKey,
                axisIndex: warning.axisIndex,
                length: warning.length,
                modelFingerprint: model.fingerprint,
              },
            })
          })
          const input = buildCalculationRecordedData(model.rules, recorded)
          if (!input.input)
            throw new Error(input.error ?? '예측 RecordedData를 Calculation input으로 만들 수 없습니다.')
          return { calculated: await executeCalculations(input.input, transaction), model, result }
        } catch (cause: unknown) {
          if (!(cause instanceof PredictionWorkerRestartError) || attempt > 0 || transaction !== transactionRef.current)
            throw cause
          clearModelCaches()
        }
      }
      throw new Error('Prediction Worker 재시도에 실패했습니다.')
    },
    [ensureForwardModel, executeCalculations, onActivity, varsSchema],
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
      primaryRevisionRef.current += 1
      const transaction = ++transactionRef.current
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) clearModelCaches()
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
        setCalculationPrimaryRevision((current) => current + 1)
        setCalculationErrors(completed.calculated.errors)
        setSurrogateValues({})
        setSurrogateErrors({})
        setNeighborsByDirection((current) => ({ ...current, forward: completed.result.neighbors }))
        setLastResult(completed.result)
        rememberProfile(completed.model.profile, completed.model.fingerprint)
        setForwardVarsFingerprint(candidateFingerprint(vars))
        if (userChangedVarsRef.current) setGuideProgress((current) => ({ ...current, forward: true }))
        setInverseVarsFingerprint(null)
        setStatus(
          Object.keys(completed.calculated.errors).length
            ? 'Forward 완료 · 일부 Calculation 실패'
            : 'Forward 완료 · CalculationData가 최신입니다.',
        )
      } catch (cause: unknown) {
        if (transaction !== transactionRef.current || (cause as { name?: string })?.name === 'AbortError') return
        clearModelCaches()
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        toast.error(message)
      } finally {
        if (transaction === transactionRef.current) setBusy(false)
      }
    },
    [context, experimentId, forwardOutputs, rememberProfile, setup.calculationIds.length],
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
      primaryRevisionRef.current += 1
      const transaction = ++transactionRef.current
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) clearModelCaches()
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
            if (transaction !== transactionRef.current) return
            emitPredictionQueryDiagnostics(
              result,
              model.fingerprint,
              emittedDiagnosticFingerprintsRef.current,
              onActivity,
            )
            prediction = Object.freeze({ model, result })
            break
          } catch (cause: unknown) {
            if (
              !(cause instanceof PredictionWorkerRestartError) ||
              attempt > 0 ||
              transaction !== transactionRef.current
            )
              throw cause
            clearModelCaches()
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
        setGuideProgress((current) => ({ ...current, inverse: true }))
        setForwardVarsFingerprint(null)
        setNeighborsByDirection((current) => ({ ...current, inverse: result.neighbors }))
        setLastResult(result)
        rememberProfile(model.profile, model.fingerprint)
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
          clearModelCaches()
          setSurrogateValues({})
          setSurrogateErrors({})
          setStatus(`Inverse 완료 · surrogate unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      } catch (cause: unknown) {
        if (transaction !== transactionRef.current || (cause as { name?: string })?.name === 'AbortError') return
        clearModelCaches()
        const message = cause instanceof Error ? cause.message : String(cause)
        setStatus(message)
        toast.error(message)
      } finally {
        if (transaction === transactionRef.current) setBusy(false)
      }
    },
    [
      context,
      ensureInverseModel,
      experimentId,
      forwardOutputs,
      onActivity,
      rememberProfile,
      setup.calculationIds,
      varsSchema,
      workbench,
    ],
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
      primaryRevisionRef.current += 1
      transactionRef.current += 1
      calculationAbortRef.current?.abort()
      if (clientRef.current?.cancelPending()) clearModelCaches()
      setDirection('inverse')
      setInverseVarsFingerprint(null)
      setForwardVarsFingerprint(null)
      setValidation(null)
      setSurrogateValues({})
      setSurrogateErrors({})
      const next = Object.freeze({ ...calculationValuesRef.current, [calculationId]: output })
      calculationValuesRef.current = next
      setCalculationValues(next)
      if (setup.calculationIds.every((id) => next[id])) void runInverse(next)
      else {
        setBusy(false)
        setStatus('Inverse 대기 · 선택한 모든 CalculationData Target을 채우세요.')
      }
    },
    [runInverse, setup.calculationIds],
  )

  const validationDisabledReason = useMemo(() => {
    if (!authenticated) return '로그인 후 검증할 수 있습니다.'
    if (!workbench.experimentManageable) return '이 Experiment의 데이터를 변경할 권한이 없습니다.'
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
    workbench.experimentManageable,
  ])

  const samplingDisabledReason = useMemo(() => {
    if (!authenticated) return '로그인 후 sampling할 수 있습니다.'
    if (!workbench.experimentManageable) return '이 Experiment의 데이터를 변경할 권한이 없습니다.'
    if (!contextExperimentMatches || !varsSchema) return '현재 Experiment의 Prediction 데이터를 불러오는 중입니다.'
    if (freshnessPending) return 'Prediction 데이터 최신성을 확인하는 중입니다.'
    if (!workbench.experimentClean || experimentId === null) return '저장되고 수정되지 않은 Experiment가 필요합니다.'
    if (busy || workbench.measurementActions.busy || workbench.calculationDataActions.busy)
      return '진행 중인 작업이 있습니다.'
    if (dataStale) return 'Prediction 데이터를 Reload하세요.'
    if (workbench.measurementActions.pendingRecordMeasurementId) return 'RecordedData 저장을 먼저 다시 시도하세요.'
    if (workbench.experimentDocument.draftTaskNames.length > 0) return 'Solver가 선택되지 않은 Draft Task가 있습니다.'
    let active = false
    for (const [key, entry] of Object.entries(varsSchema)) {
      const range = effectiveSamplingRanges[key]
      if (
        !range ||
        !Number.isFinite(range.min) ||
        !Number.isFinite(range.max) ||
        range.min < entry.min ||
        range.max > entry.max ||
        range.min > range.max
      ) {
        return `${key} sampling 범위가 schema 범위 안의 올바른 Min/Max여야 합니다.`
      }
      if (range.min < range.max) active = true
    }
    if (!active) return 'Sampling 범위가 고정되지 않은 Vars가 하나 이상 필요합니다.'
    return undefined
  }, [
    authenticated,
    busy,
    contextExperimentMatches,
    dataStale,
    effectiveSamplingRanges,
    experimentId,
    freshnessPending,
    varsSchema,
    workbench.calculationDataActions.busy,
    workbench.experimentClean,
    workbench.experimentDocument.draftTaskNames,
    workbench.experimentManageable,
    workbench.measurementActions.busy,
    workbench.measurementActions.pendingRecordMeasurementId,
  ])

  const sampleAndRun = useCallback(
    async (total: number) => {
      if (samplingDisabledReason) {
        toast.error(samplingDisabledReason)
        return
      }
      if (!Number.isSafeInteger(total) || total <= 0 || !clientRef.current || !context || !varsSchema) {
        toast.error('Sampling N은 양의 JavaScript safe integer여야 합니다.')
        return
      }
      const revision = ++samplingRevisionRef.current
      const sessionId = crypto.randomUUID()
      const fingerprint = predictionFingerprint([
        'prediction-sampling',
        context.fingerprint,
        sourceIdentity,
        effectiveSamplingRanges,
        total,
      ])
      const centers = context.measurements.flatMap((measurement) => {
        try {
          return [predictionVarsSamples(measurement.vars as Readonly<Vars>, varsSchema)]
        } catch {
          return []
        }
      })
      let successes = 0
      let failures = 0
      let recorded = 0
      let attempted = 0
      let stoppedReason: string | null = null
      clientRef.current.reset()
      clearModelCaches()
      setBusy(true)
      setSamplingProgress({ attempt: 0, failures: 0, phase: 'candidate', recorded: 0, sessionId, successes: 0, total })
      setValidation(null)
      setStatus('Sampling 후보 안전 예산을 확인하는 중…')
      try {
        const profile = await clientRef.current.startSampling(sessionId, {
          fingerprint,
          totalAttempts: total,
          layouts: predictionVarsLayouts(varsSchema),
          ranges: effectiveSamplingRanges,
          centers,
        })
        if (revision !== samplingRevisionRef.current) return
        onActivity?.({
          source: 'prediction',
          level: 'info',
          phase: 'sampling',
          message: `[Sampling] ${profile.existingCenterCount.toLocaleString()} centers · ${profile.candidateCount.toLocaleString()} candidates/window · ${profile.activeComponentCount.toLocaleString()} active components`,
        })
        for (let attempt = 1; attempt <= total; attempt += 1) {
          if (revision !== samplingRevisionRef.current) break
          if (sourceIdentityRef.current !== sourceIdentity) {
            stoppedReason = 'Experiment 또는 source가 변경되었습니다.'
            break
          }
          attempted = attempt
          setSamplingProgress({ attempt, failures, phase: 'candidate', recorded, sessionId, successes, total })
          setStatus(`${attempt}/${total} · Candidate 평가 · 성공 ${successes} · 실패 ${failures}`)
          let sample: readonly import('./knn').PredictionTensorSample[] | null = null
          try {
            sample = await clientRef.current.nextSample(sessionId, fingerprint, attempt)
            if (revision !== samplingRevisionRef.current) break
            const nextVars = Object.freeze(
              Object.fromEntries(
                sample.map((entry) => [entry.layout.key, varsTensorFromFlat(entry.values, entry.layout.shape)]),
              ),
            ) as Readonly<Vars>
            const expectedFingerprint = candidateFingerprint(nextVars)
            const baselineRevision = experimentDocumentRef.current.revision
            suppressedCandidateRef.current = expectedFingerprint
            if (!setCandidateVariablesRef.current(nextVars, 'prediction-sampling')) {
              throw new Error('Sampling Candidate Vars를 적용하지 못했습니다.')
            }
            await new Promise<void>((resolve, reject) => {
              const poll = () => {
                if (revision !== samplingRevisionRef.current) {
                  reject(new DOMException('Sampling이 취소되었습니다.', 'AbortError'))
                  return
                }
                if (sourceIdentityRef.current !== sourceIdentity) {
                  reject(new Error('Experiment 또는 source가 변경되어 Sampling을 중단합니다.'))
                  return
                }
                const document = experimentDocumentRef.current
                const currentVars = candidateVarsRef.current
                if (
                  currentVars &&
                  candidateFingerprint(currentVars) === expectedFingerprint &&
                  document.variables &&
                  candidateFingerprint(document.variables) === expectedFingerprint &&
                  document.revision > baselineRevision &&
                  document.successfulRevision === document.revision &&
                  document.status === 'Ready'
                ) {
                  resolve()
                  return
                }
                if (document.revision > baselineRevision && document.status === 'Error') {
                  reject(new Error(document.error?.message ?? 'Sampling Candidate 평가에 실패했습니다.'))
                  return
                }
                window.setTimeout(poll, 50)
              }
              poll()
            })
            if (revision !== samplingRevisionRef.current) break
            setSamplingProgress({ attempt, failures, phase: 'simulation', recorded, sessionId, successes, total })
            setStatus(`${attempt}/${total} · Simulation 및 RecordedData 저장 · 성공 ${successes} · 실패 ${failures}`)
            const completion = await measurementActionsRef.current.saveAndRunCurrentAsync()
            if (revision !== samplingRevisionRef.current) break
            recorded += 1
            await clientRef.current.acceptSample(sessionId, fingerprint, sample)
            if (completion.calculationSummary.failed === 0 && !completion.calculationSummary.cancelled) successes += 1
            else failures += 1
          } catch (cause: unknown) {
            if (revision !== samplingRevisionRef.current || (cause as { name?: string })?.name === 'AbortError') break
            failures += 1
            const message = cause instanceof Error ? cause.message : String(cause)
            const saveBlocked =
              Boolean(measurementActionsRef.current.pendingRecordMeasurementId) ||
              /RecordedData.*저장|저장.*RecordedData/.test(message)
            onActivity?.({
              source: 'prediction',
              level: 'error',
              phase: 'sampling',
              message: `[Sampling ${attempt}/${total}] ${message}`,
            })
            if (saveBlocked || sourceIdentityRef.current !== sourceIdentity) {
              stoppedReason = message
              setStatus(`${attempt}/${total} · Sampling 중단 · ${message}`)
              break
            }
          }
        }
      } catch (cause: unknown) {
        if (revision === samplingRevisionRef.current && (cause as { name?: string })?.name !== 'AbortError') {
          const message = cause instanceof Error ? cause.message : String(cause)
          setStatus(`Sampling 실패 · ${message}`)
          toast.error(message)
        }
      } finally {
        if (revision === samplingRevisionRef.current) {
          setSamplingProgress({
            attempt: Math.min(total, samplingProgressRef.current?.attempt ?? total),
            failures,
            phase: 'stopping',
            recorded,
            sessionId,
            successes,
            total,
          })
          await clientRef.current?.dropSampling(sessionId).catch(() => undefined)
          clearModelCaches()
          setForwardVarsFingerprint(null)
          setInverseVarsFingerprint(null)
          if (recorded > 0) setFreshnessPending(true)
          else setFreshnessPending(false)
          setStatus(
            stoppedReason
              ? `Sampling 중단 · ${attempted}/${total}회 · 성공 ${successes} · 실패 ${failures} · ${stoppedReason}`
              : `Sampling 완료 · ${attempted}/${total}회 · 성공 ${successes} · 실패 ${failures} · Recorded ${recorded}`,
          )
          setSamplingProgress(null)
          if (recorded === 0) skipNextPredictionBusyCheckRef.current = true
          setBusy(false)
          if (recorded === 0 && candidateVarsRef.current) {
            window.setTimeout(() => void runForward(candidateVarsRef.current!), 0)
          }
        }
      }
    },
    [
      clearModelCaches,
      context,
      effectiveSamplingRanges,
      onActivity,
      runForward,
      samplingDisabledReason,
      setFreshnessPending,
      sourceIdentity,
      varsSchema,
      workbench,
    ],
  )

  useEffect(() => {
    if (!samplingProgress || samplingProgress.phase !== 'simulation' || !workbench.measurementActions.stage) return
    setStatus(
      `${samplingProgress.attempt}/${samplingProgress.total} · ${workbench.measurementActions.stage} · 성공 ${samplingProgress.successes} · 실패 ${samplingProgress.failures}`,
    )
  }, [samplingProgress, workbench.measurementActions.stage])

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
    const frozenPrimaryRevision = primaryRevisionRef.current
    const frozenRepredicted = Object.freeze(frozenDirection === 'inverse' ? { ...surrogateValues } : {})
    const frozenSetup = setup
    const frozenTransactionId = transactionRef.current
    setBusy(true)
    setValidating(true)
    setSetupOpen(false)
    setDetailsDirection(frozenDirection)
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
        frozenPrimaryRevision,
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
          primaryRevision: frozenPrimaryRevision,
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
      clearModelCaches()
      setForwardVarsFingerprint(null)
      setInverseVarsFingerprint(null)
      setFreshnessPending(true)
    } catch (cause: unknown) {
      if (validationRevision !== validationRevisionRef.current) return
      if (datasetMutated) {
        clientRef.current?.reset()
        clearModelCaches()
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setFreshnessPending(true)
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
      !workbench.experimentManageable ||
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
  }, [
    contextExperimentMatches,
    experimentId,
    validation,
    workbench.calculationDataActions,
    workbench.experimentManageable,
  ])

  useEffect(() => {
    if (!command) return
    if (command.type === 'settings') {
      setSetupDraft(setup)
      setSetupOpen(true)
    } else if (command.type === 'details') {
      setDetailsDirection(direction)
      setDetailsOpen(true)
    } else if (command.type === 'cancel') cancelCurrent()
    else if (command.type === 'sample') void sampleAndRun(command.sampleCount ?? 10)
    else void validatePrediction()
  }, [command?.id])

  const setupDraftError = useMemo(() => {
    if (!setupDraft.calculationIds.length) return 'Calculation을 하나 이상 선택하세요.'
    if (
      setupDraft.calculationIds.some(
        (id) => context?.calculations.find((calculation) => calculation.id === id)?.contract_status !== 'ready',
      )
    ) {
      return '선택한 Calculation을 Calculation 탭에서 preflight 후 다시 저장하세요.'
    }
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

  const initializeMissingInverseTargets = useCallback(async () => {
    const missingIds = setup.calculationIds.filter((id) => !calculationValuesRef.current[id])
    if (!missingIds.length) {
      await runInverse(calculationValuesRef.current)
      return
    }
    if (!candidateVars) {
      setCalculationErrors(Object.freeze(Object.fromEntries(missingIds.map((id) => [id, 'Target이 필요합니다.']))))
      setStatus('새 Calculation의 Target을 초기화할 Candidate가 없습니다.')
      return
    }
    const transaction = ++transactionRef.current
    calculationAbortRef.current?.abort()
    if (clientRef.current?.cancelPending()) clearModelCaches()
    setBusy(true)
    setStatus('새 Calculation Target을 현재 Candidate의 Forward 예측으로 초기화하는 중…')
    try {
      const completed = await forwardOutputs(candidateVars, transaction)
      if (transaction !== transactionRef.current) return
      const nextValues = { ...calculationValuesRef.current }
      const nextErrors: Record<number, string> = {}
      missingIds.forEach((id) => {
        if (completed.calculated.values[id]) nextValues[id] = completed.calculated.values[id]
        else nextErrors[id] = completed.calculated.errors[id] ?? 'Forward 예측 Target을 만들지 못했습니다.'
      })
      const frozen = Object.freeze(nextValues)
      calculationValuesRef.current = frozen
      setCalculationValues(frozen)
      setCalculationErrors(Object.freeze(nextErrors))
      if (setup.calculationIds.every((id) => frozen[id])) await runInverse(frozen)
      else setStatus('일부 새 Calculation Target을 초기화하지 못했습니다. 해당 Calculation을 확인하세요.')
    } catch (cause: unknown) {
      if (transaction !== transactionRef.current || (cause as { name?: string })?.name === 'AbortError') return
      const message = cause instanceof Error ? cause.message : String(cause)
      setCalculationErrors(Object.freeze(Object.fromEntries(missingIds.map((id) => [id, message]))))
      setStatus(message)
      toast.error(message)
    } finally {
      if (transaction === transactionRef.current) setBusy(false)
    }
  }, [candidateVars, forwardOutputs, runInverse, setup.calculationIds])

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
    clearModelCaches()
    setProfiles({})
    setNeighborsByDirection({})
    inverseRowsRef.current = null
    lastCandidateRef.current = currentCandidateFingerprint
    setSetupAppliedRevision((current) => current + 1)
  }, [cancelCurrent, currentCandidateFingerprint, setupDraft, setupDraftError])

  useEffect(() => {
    if (!setupAppliedRevision || !context) return
    if (direction === 'inverse') {
      void initializeMissingInverseTargets()
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
      !workbench.experimentManageable ||
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
    workbench.experimentManageable,
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
      canSample: samplingDisabledReason === undefined,
      canValidate: validationDisabledReason === undefined,
      direction,
      sampleDisabledReason: samplingDisabledReason,
      status,
      validateDisabledReason: validationDisabledReason,
    })
  }, [busy, direction, onChromeStateChange, samplingDisabledReason, status, validationDisabledReason])

  const paneItems = useMemo<readonly PredictionCalculationPaneItem[]>(
    () =>
      selectedCalculations.map((calculation) => {
        const committedOutput = calculationValues[calculation.id] ?? null
        const output =
          committedOutput ?? (calculation.output_layout ? calculationPlaceholder(calculation.output_layout) : null)
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
          committedOutput &&
          candidateValidationRow &&
          predictionFingerprint([candidateValidationRow.reference]) === predictionFingerprint([committedOutput])
            ? candidateValidationRow
            : null
        const repredictedOutput =
          direction === 'inverse'
            ? (validationSnapshotCurrent?.repredicted[calculation.id] ?? surrogateValues[calculation.id] ?? null)
            : null
        const repredictedMetric =
          committedOutput && repredictedOutput ? comparePredictionOutput(committedOutput, repredictedOutput) : null
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
        const [minimum, maximum] = predictionOutputRange([output])
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
          primary: Object.freeze({
            output,
            role: direction === 'forward' ? 'predicted' : 'target',
            status: committedOutput ? ('ready' as const) : busy ? ('updating' as const) : ('unavailable' as const),
          }),
          error:
            calculationErrors[calculation.id] ??
            (committedOutput ? null : busy ? 'Prediction 결과를 계산하는 중입니다.' : 'Prediction 결과가 없습니다.'),
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
    if (lastResult?.queryDiagnostics.length) {
      warnings.push(
        `현재 query의 metadata 차이 ${lastResult.queryDiagnostics.length.toLocaleString()}개를 무시하고 같은 shape의 cell index 기준으로 예측했습니다.`,
      )
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
      currentExperimentId={experimentId}
      candidateSessionKey={`${experimentId ?? 'none'}:prediction`}
      demos={availableQuery.data?.demos ?? []}
      direction={direction}
      disabled={
        validating || samplingProgress !== null || dataStale || freshnessPending || !varsSchema || !candidateVars
      }
      guideVisible={workbench.experimentIsDemo && (!guideProgress.forward || !guideProgress.inverse)}
      isDemo={workbench.experimentIsDemo}
      manageable={workbench.experimentManageable}
      loadingExperiments={availableQuery.isPending}
      mine={availableQuery.data?.mine ?? []}
      resetValues={resetValues}
      samplingRanges={effectiveSamplingRanges}
      schema={varsSchema}
      status={status}
      updating={busy}
      vars={candidateVars}
      onDismissGuide={() => setGuideProgress({ forward: true, inverse: true })}
      onExperimentChange={(id) => {
        const row = [...(availableQuery.data?.mine ?? []), ...(availableQuery.data?.demos ?? [])].find(
          (item) => item.id === id,
        )
        if (row && row.id !== experimentId) onExperimentChange(row)
      }}
      onSamplingRangeChange={(key, range) =>
        setSamplingRanges((current) => Object.freeze({ ...current, [key]: Object.freeze(range) }))
      }
      onVariableChange={(key: string, value: Tensor) => {
        if (freshnessPendingRef.current || dataStaleRef.current) return
        if (!candidateVars) return
        const nextVars = Object.freeze({ ...candidateVars, [key]: value })
        if (candidateFingerprint(nextVars) === currentCandidateFingerprint) return
        if (!workbench.setCandidateVariables(nextVars, 'user-vars')) return
        userChangedVarsRef.current = true
        primaryRevisionRef.current += 1
        transactionRef.current += 1
        calculationAbortRef.current?.abort()
        if (clientRef.current?.cancelPending()) clearModelCaches()
        setDirection('forward')
        setForwardVarsFingerprint(null)
        setInverseVarsFingerprint(null)
        setValidation(null)
        setSurrogateValues({})
        setSurrogateErrors({})
      }}
    />
  )

  if (!dataReadable) {
    return (
      <>
        {varsContainer ? createPortal(varsPane, varsContainer) : null}
        <div className="grid h-full place-items-center p-6 text-center">
          <div>
            <p className="font-medium">왼쪽에서 공개 Demo를 선택하거나 로그인하세요.</p>
            <button className="mt-3 text-sm font-medium text-primary underline" type="button" onClick={onRequestLogin}>
              로그인
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {varsContainer ? createPortal(varsPane, varsContainer) : null}
      <PredictionCalculationPane
        disabled={validating || dataStale || freshnessPending}
        items={paneItems}
        mode={direction === 'forward' ? 'prediction' : 'target'}
        resetKey={`${experimentId ?? 'none'}:${calculationPrimaryRevision}`}
        status={status}
        updating={busy}
        onOutputChange={changeCalculationOutput}
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
          !workbench.experimentManageable ||
          workbench.measurementActions.busy ||
          workbench.calculationDataActions.busy
        }
        calculateMissingLabel={
          authenticated
            ? workbench.experimentManageable
              ? '누락 데이터 계산'
              : '데이터 변경 권한 없음'
            : '로그인하여 데이터 계산'
        }
        calculations={
          contextExperimentMatches
            ? context.calculations.map((calculation) => ({
                id: calculation.id,
                name: calculation.name,
                description: calculation.description,
                dependencyNames: calculation.experiment_record_ids.map(
                  (recordId) =>
                    context.experimentRecords.find((record) => record.id === recordId)?.name ?? `#${recordId}`,
                ),
                disabled: calculation.contract_status !== 'ready' || !calculation.output_layout,
                disabledReason:
                  calculation.contract_status !== 'ready' || !calculation.output_layout
                    ? 'Calculation 탭에서 성공한 preflight 후 다시 저장해야 합니다.'
                    : undefined,
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
        cohortSummaries={
          setupDraftApplied && contextExperimentMatches
            ? Object.freeze({
                ...(profiles.forward ? { forward: cohortSummary(profiles.forward, context.measurements.length)! } : {}),
                ...(profiles.inverse ? { inverse: cohortSummary(profiles.inverse, context.measurements.length)! } : {}),
              })
            : {}
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
        onCalculateMissing={() => (authenticated ? void calculateMissing() : onRequestLogin())}
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
        direction={detailsDirection}
        forwardRecordProfiles={forwardRecordProfiles}
        neighbors={neighborsByDirection[detailsDirection] ?? []}
        open={detailsOpen}
        profiles={profiles}
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
        onDirectionChange={setDetailsDirection}
        onOpenChange={setDetailsOpen}
        onRetryCalculations={
          validation && workbench.experimentManageable ? () => void retryValidationCalculations() : undefined
        }
      />
    </>
  )
}
