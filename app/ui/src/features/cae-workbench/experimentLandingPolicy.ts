import type { WorkbenchDraft } from '@/features/cae-workbench/types'
import type { ExperimentSourceBundle } from '@/lib/cad/source'

export function draftNeedsLandingPreservation(draft: WorkbenchDraft | null, starterBundle: ExperimentSourceBundle) {
  if (!draft) return false
  const document = draft.experiment.document?.sourceBundle ?? null
  const baseline = draft.experiment.baselineBundle
  const dirty = Boolean(document && baseline && JSON.stringify(document) !== JSON.stringify(baseline))
  const meaningfulLocal =
    !draft.experiment.record &&
    (JSON.stringify(document) !== JSON.stringify(starterBundle) || draft.experiment.name !== 'Starter Experiment')
  return dirty || meaningfulLocal
}
