import type { Vars, VarsSchemaEntry } from '@/lib/cad/model'
import type { RecordedDataSchemaTree } from '@/lib/cad/simulation'
import type { BoxGridData } from '@/contracts/boxGrid'
import type { RecordedResultContracts } from '@/contracts/results'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { predictedRecordedData, predictionFingerprint } from './data'
import { emitPredictionCohortDiagnostics, emitPredictionQueryDiagnostics } from './diagnostics'
import type { PredictionAlgorithm, PredictionModelProfile } from './execution'
import type { PredictionContext } from './predictionContextData'
import { loadTrainingSnapshot } from './trainingSnapshot'
import type {
  PredictionForwardModelBundle,
  PredictionForwardRecordProfile,
  PredictionRuntimeController,
} from './usePredictionController'

export type ForwardBuildOptions = Readonly<{
  context: PredictionContext | null
  experimentId: number | null
  requiredRecordIds: readonly number[]
  varsSchema: Readonly<Record<string, VarsSchemaEntry>> | null
  runtime: PredictionRuntimeController
  transaction: number
  recordedData: RecordedDataSchemaTree
  resultContracts: RecordedResultContracts
  setup: Readonly<{ algorithm: PredictionAlgorithm; executionId: string }>
  checkFreshness?: () => Promise<string>
  onActivity?: RuntimeActivityCallback
  onForwardRecordProfilesChange: (profiles: readonly PredictionForwardRecordProfile[]) => void
  onProfile: (profile: PredictionModelProfile, fingerprint: string) => void
}>

export async function buildForwardModel({
  context,
  experimentId,
  requiredRecordIds,
  varsSchema,
  runtime,
  transaction,
  recordedData,
  resultContracts,
  setup,
  checkFreshness,
  onActivity,
  onForwardRecordProfilesChange,
  onProfile,
}: ForwardBuildOptions): Promise<PredictionForwardModelBundle> {
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  if (!context || context.experimentId !== experimentId || !varsSchema || !runtime.executionAvailable)
    throw new Error('Forward 모델 context가 준비되지 않았습니다.')
  if (!requiredRecordIds.length) throw new Error('선택한 Calculation이 사용하는 ExperimentRecord가 없습니다.')
  const key = predictionFingerprint([context.fingerprint, requiredRecordIds, varsSchema, recordedData, resultContracts])
  const snapshot = await runtime.trainingSnapshot(
    'forward',
    key,
    () =>
      loadTrainingSnapshot({
        context,
        experimentId,
        direction: 'forward',
        varsSchema,
        requiredRecordIds,
        recordedData,
        resultContracts,
        signal: runtime.transactionSignal(),
        policy: runtime.trainingPolicy,
        checkFreshness,
      }),
    transaction,
  )
  const model = await runtime.prepareModel(snapshot, setup.algorithm, transaction, setup.executionId)
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  onForwardRecordProfilesChange(model.recordProfiles)
  emitPredictionCohortDiagnostics(model.profile, model.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
  onProfile(model.profile, model.fingerprint)
  return model
}

/** Inference only: rebuilding is controlled by the current transaction. */
export async function predictForwardRecorded({
  model,
  runtime,
  transaction,
  vars,
  candidateBoxGrids,
  onActivity,
}: Readonly<{
  model: PredictionForwardModelBundle
  runtime: PredictionRuntimeController
  transaction: number
  vars: Readonly<Vars>
  candidateBoxGrids: Readonly<Record<string, BoxGridData>>
  onActivity?: RuntimeActivityCallback
}>) {
  const result = await runtime.predict(model, { direction: 'forward', vars }, transaction)
  if (!runtime.transactionIsCurrent(transaction)) throw new DOMException('Stale Prediction transaction', 'AbortError')
  emitPredictionQueryDiagnostics(result, model.fingerprint, runtime.emittedDiagnosticFingerprints, onActivity)
  model.rules.forEach((rule) => {
    if (!candidateBoxGrids[rule.label]) throw new Error(`${rule.label} Candidate Box Grid가 없습니다.`)
  })
  const recorded = predictedRecordedData(
    result.output,
    model.rules,
    (warning) => {
      const key = `axis-fallback:${model.fingerprint}:${warning.blockKey}:${warning.axisIndex}`
      if (runtime.emittedDiagnosticFingerprints.has(key)) return
      runtime.emittedDiagnosticFingerprints.add(key)
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
    },
    candidateBoxGrids,
  )
  return { recorded, result, model }
}
