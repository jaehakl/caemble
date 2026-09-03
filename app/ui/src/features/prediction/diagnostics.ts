import {
  emitRuntimeActivity,
  type RuntimeActivityCallback,
  type RuntimeActivityDraft,
} from '@/features/runtime-console/types'
import type { PredictionResult } from './knn'
import type { PredictionWorkerModelProfile } from './protocol'

export const PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT = 100

export function predictionCohortDiagnosticActivities(
  profile: PredictionWorkerModelProfile,
): readonly RuntimeActivityDraft[] {
  const directionLabel = profile.direction === 'forward' ? 'Forward' : 'Inverse'
  const activities: RuntimeActivityDraft[] = profile.diagnostics
    .slice(0, PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT)
    .map((diagnostic) => ({
      source: 'prediction',
      level: 'warning',
      phase: `cohort.${profile.direction}`,
      message: `[${directionLabel} cohort] ${diagnostic.measurementIds.map((id) => `#${id}`).join(', ')} · ${diagnostic.side} ${diagnostic.blockKey}.${diagnostic.fieldPath}: ${diagnostic.expected} → ${diagnostic.actual}`,
      details: {
        direction: diagnostic.direction,
        disposition: diagnostic.disposition,
        reason: diagnostic.reason,
        baselineMeasurementId: diagnostic.baselineMeasurementId,
        measurementCount: diagnostic.measurementIds.length,
        block: diagnostic.blockKey,
        field: diagnostic.fieldPath,
        expected: diagnostic.expected,
        actual: diagnostic.actual,
        mismatchCount: diagnostic.mismatchCount ?? null,
        firstMismatchIndex: diagnostic.firstMismatchIndex ?? null,
        maxAbsoluteDifference: diagnostic.maxAbsoluteDifference ?? null,
      },
    }))
  const omitted =
    Math.max(0, profile.diagnostics.length - PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT) + profile.omittedDiagnosticGroups
  if (omitted > 0) {
    activities.push({
      source: 'prediction',
      level: 'warning',
      phase: `cohort.${profile.direction}`,
      message: `[${directionLabel} cohort] Console 표시 한도를 넘어 ${omitted.toLocaleString()}개 진단 그룹을 생략했습니다. Prediction 세부 정보를 확인하세요.`,
      details: { omittedDiagnosticGroups: omitted },
    })
  }
  return Object.freeze(activities)
}

export function emitPredictionCohortDiagnostics(
  profile: PredictionWorkerModelProfile,
  fingerprint: string,
  emittedFingerprints: Set<string>,
  onActivity: RuntimeActivityCallback | undefined,
) {
  if (!onActivity) return false
  const diagnosticFingerprint = `${profile.direction}:${fingerprint}`
  if (emittedFingerprints.has(diagnosticFingerprint)) return false
  emittedFingerprints.add(diagnosticFingerprint)
  predictionCohortDiagnosticActivities(profile).forEach((activity) => emitRuntimeActivity(onActivity, activity))
  return true
}

export function emitPredictionQueryDiagnostics(
  result: PredictionResult,
  modelFingerprint: string,
  emittedFingerprints: Set<string>,
  onActivity: RuntimeActivityCallback | undefined,
) {
  if (!onActivity || result.queryDiagnostics.length === 0) return false
  const fingerprint = `query:${result.direction}:${modelFingerprint}:${JSON.stringify(result.queryDiagnostics)}`
  if (emittedFingerprints.has(fingerprint)) return false
  emittedFingerprints.add(fingerprint)
  const directionLabel = result.direction === 'forward' ? 'Forward' : 'Inverse'
  result.queryDiagnostics.slice(0, PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT).forEach((diagnostic) => {
    emitRuntimeActivity(onActivity, {
      source: 'prediction',
      level: 'warning',
      phase: `query.${result.direction}`,
      message: `[${directionLabel} query] ${diagnostic.blockKey}.${diagnostic.fieldPath}: ${diagnostic.expected} → ${diagnostic.actual}; shape가 같아 cell index 기준으로 예측합니다.`,
      details: {
        direction: result.direction,
        block: diagnostic.blockKey,
        field: diagnostic.fieldPath,
        expected: diagnostic.expected,
        actual: diagnostic.actual,
        mismatchCount: diagnostic.mismatchCount ?? null,
        firstMismatchIndex: diagnostic.firstMismatchIndex ?? null,
        maxAbsoluteDifference: diagnostic.maxAbsoluteDifference ?? null,
      },
    })
  })
  const omitted = Math.max(0, result.queryDiagnostics.length - PREDICTION_CONSOLE_DIAGNOSTIC_LIMIT)
  if (omitted > 0) {
    emitRuntimeActivity(onActivity, {
      source: 'prediction',
      level: 'warning',
      phase: `query.${result.direction}`,
      message: `[${directionLabel} query] Console 표시 한도를 넘어 ${omitted.toLocaleString()}개 metadata 진단을 생략했습니다.`,
      details: { omittedDiagnosticGroups: omitted },
    })
  }
  return true
}
