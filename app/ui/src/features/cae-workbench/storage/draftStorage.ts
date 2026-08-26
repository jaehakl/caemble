import type { WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:workbench-draft'
const RETIRED_DRAFT_KEYS = ['caemble:cae-workbench-draft', 'caemble:cae-workbench-draft:v1'] as const

export async function loadWorkbenchDraft(): Promise<WorkbenchDraft | null> {
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
  const serialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
  return serialized === null ? null : (JSON.parse(serialized) as WorkbenchDraft)
}

export async function saveWorkbenchDraft(draft: WorkbenchDraft) {
  sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export async function clearWorkbenchDraft() {
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
}
