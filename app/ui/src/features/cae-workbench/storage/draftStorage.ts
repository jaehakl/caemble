import type { WorkbenchDraft } from '../types'
import { analysisTabIds, defaultWorkbenchLayoutState, workbenchSectionIds } from '../types'

export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:workbench-draft'
const RETIRED_DRAFT_KEYS = ['caemble:cae-workbench-draft', 'caemble:cae-workbench-draft:v1'] as const

export async function loadWorkbenchDraft(): Promise<WorkbenchDraft | null> {
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
  const serialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
  if (serialized === null) return null
  const draft = JSON.parse(serialized) as WorkbenchDraft
  const activeSection = workbenchSectionIds.includes(draft.layout.activeSection)
    ? draft.layout.activeSection
    : defaultWorkbenchLayoutState.activeSection
  const analysisTab = analysisTabIds.includes(draft.layout.analysisTab)
    ? draft.layout.analysisTab
    : defaultWorkbenchLayoutState.analysisTab
  return { ...draft, layout: { ...draft.layout, activeSection, analysisTab } }
}

export async function saveWorkbenchDraft(draft: WorkbenchDraft) {
  sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export async function clearWorkbenchDraft() {
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
  RETIRED_DRAFT_KEYS.forEach((key) => sessionStorage.removeItem(key))
}
