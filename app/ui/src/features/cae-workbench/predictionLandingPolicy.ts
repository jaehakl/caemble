import type { AvailableExperimentRecord, AvailableExperimentsResponse } from '@/api'
import type { WorkbenchDraft } from '@/features/cae-workbench/types'
import type { ExperimentSourceBundle } from '@/lib/cad/source'

export function draftNeedsPredictionLandingPreservation(
  draft: WorkbenchDraft | null,
  starterBundle: ExperimentSourceBundle,
) {
  if (!draft) return false
  const document = draft.experiment.document?.sourceBundle ?? null
  const baseline = draft.experiment.baselineBundle
  const dirty = Boolean(document && baseline && JSON.stringify(document) !== JSON.stringify(baseline))
  const meaningfulLocal =
    !draft.experiment.record &&
    (JSON.stringify(document) !== JSON.stringify(starterBundle) || draft.experiment.name !== 'Starter Experiment')
  return dirty || meaningfulLocal
}

export function predictionLandingExperiment(
  available: AvailableExperimentsResponse,
  lastExperimentId: number | null,
): AvailableExperimentRecord | null {
  return (
    available.mine.find((item) => item.id === lastExperimentId && item.predictionReady) ??
    available.mine[0] ??
    available.demos.find((item) => item.demoDefault && item.predictionReady) ??
    available.demos.find((item) => item.predictionReady) ??
    null
  )
}
