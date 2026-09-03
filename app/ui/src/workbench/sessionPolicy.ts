export type ReplacementDisposition =
  | 'blocked-by-pending-record'
  | 'blocked-by-running-workflow'
  | 'blocked-by-save'
  | 'confirm-calculation-replacement'
  | 'confirm-experiment-replacement'
  | 'run'

export function readWorkbenchUrlExperiment(searchParams: URLSearchParams) {
  const experimentId = Number(searchParams.get('experiment'))
  return Number.isSafeInteger(experimentId) && experimentId > 0 ? experimentId : null
}

export function writeWorkbenchUrlExperiment(current: URLSearchParams, experimentId: number | null) {
  const next = new URLSearchParams(current)
  if (experimentId === null) next.delete('experiment')
  else next.set('experiment', String(experimentId))
  ;['section', 'measurement', 'calculation', 'structure', 'sample', 'setup'].forEach((key) => next.delete(key))
  return next
}

export function replacementDisposition({
  calculationDirty,
  calculationRunning,
  experimentDirty,
  measurementRunning,
  pendingRecord,
  saving,
}: Readonly<{
  calculationDirty: boolean
  calculationRunning: boolean
  experimentDirty: boolean
  measurementRunning: boolean
  pendingRecord: boolean
  saving: boolean
}>): ReplacementDisposition {
  if (pendingRecord) return 'blocked-by-pending-record'
  if (saving) return 'blocked-by-save'
  if (measurementRunning || calculationRunning) return 'blocked-by-running-workflow'
  if (calculationDirty) return 'confirm-calculation-replacement'
  if (experimentDirty) return 'confirm-experiment-replacement'
  return 'run'
}
