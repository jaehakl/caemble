import { workbenchSectionIds, type WorkbenchSectionId } from '@/features/cae-workbench/types'

export type WorkbenchUrlSelection = Readonly<{
  experimentId: number | null
  measurementId: number | null
  calculationId: number | null
  section: WorkbenchSectionId | null
}>

export type ReplacementDisposition =
  | 'blocked-by-pending-record'
  | 'blocked-by-running-workflow'
  | 'blocked-by-save'
  | 'confirm-calculation-replacement'
  | 'confirm-experiment-replacement'
  | 'run'

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function readWorkbenchUrlSelection(searchParams: URLSearchParams): WorkbenchUrlSelection {
  const section = searchParams.get('section')
  return {
    experimentId: positiveId(searchParams.get('experiment')),
    measurementId: positiveId(searchParams.get('measurement')),
    calculationId: positiveId(searchParams.get('calculation')),
    section: workbenchSectionIds.includes(section as WorkbenchSectionId) ? (section as WorkbenchSectionId) : null,
  }
}

export function writeWorkbenchUrlSelection(
  current: URLSearchParams,
  selection: Omit<WorkbenchUrlSelection, 'section'> & { section: WorkbenchSectionId },
) {
  const next = new URLSearchParams(current)
  const values = {
    experiment: selection.experimentId,
    measurement: selection.measurementId,
    calculation: selection.calculationId,
  }
  Object.entries(values).forEach(([key, value]) => {
    if (value) next.set(key, String(value))
    else next.delete(key)
  })
  next.set('section', selection.section)
  ;['structure', 'sample', 'setup'].forEach((key) => next.delete(key))
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
