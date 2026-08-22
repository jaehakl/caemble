import { assertCadSourceDocument, assertExperimentSourceBundle } from '@/lib/cad'
import type { WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_VERSION = 14 as const
export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:cae-workbench-draft'

const validTabs = ['experiment', 'experiments', 'recorded-data', 'ai-helper']

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validOptionalId(value: unknown) {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function isWorkbenchDraft(value: unknown): value is WorkbenchDraft {
  if (!plainObject(value)) return false
  const draft = value as unknown as WorkbenchDraft
  try {
    if (
      draft.version !== WORKBENCH_DRAFT_VERSION ||
      !Number.isFinite(draft.savedAt) ||
      !plainObject(draft.experiment) ||
      typeof draft.experiment.name !== 'string' ||
      typeof draft.experiment.description !== 'string' ||
      !plainObject(draft.candidate) ||
      (draft.candidate.vars !== null && !plainObject(draft.candidate.vars)) ||
      (draft.candidate.materialParameters !== null && !plainObject(draft.candidate.materialParameters)) ||
      !plainObject(draft.selection) ||
      !validOptionalId(draft.selection.measurementId) ||
      !plainObject(draft.layout) ||
      !Array.isArray(draft.layout.openTabs) ||
      draft.layout.openTabs.some((tab) => !validTabs.includes(tab)) ||
      (draft.layout.activeTab !== null && !validTabs.includes(draft.layout.activeTab)) ||
      (draft.layout.experimentFile !== null && typeof draft.layout.experimentFile !== 'string') ||
      !Number.isFinite(draft.layout.splitPercent)
    ) {
      return false
    }
    if (draft.experiment.document !== null) assertCadSourceDocument(draft.experiment.document)
    if (draft.experiment.baselineBundle !== null) assertExperimentSourceBundle(draft.experiment.baselineBundle)
    if (draft.experiment.record !== null) {
      if (!plainObject(draft.experiment.record)) return false
      assertExperimentSourceBundle(draft.experiment.record.source_bundle)
    }
    return true
  } catch {
    return false
  }
}

export async function loadWorkbenchDraft() {
  const serialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
  if (serialized === null) return null
  try {
    const stored = JSON.parse(serialized) as unknown
    if (!isWorkbenchDraft(stored)) throw new Error('Invalid Workbench draft.')
    return stored
  } catch {
    sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
    return null
  }
}

export async function saveWorkbenchDraft(draft: WorkbenchDraft) {
  sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export async function clearWorkbenchDraft() {
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
}
