import { createStore, del, get, set } from 'idb-keyval'
import type { WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_VERSION = 2 as const
export const ANONYMOUS_WORKBENCH_USER = 'anonymous'

const draftsStore = createStore('caemble', 'cae-workbench-drafts')

export function workbenchDraftUserKey(userId: string | null | undefined) {
  const normalized = userId?.trim()
  return normalized || ANONYMOUS_WORKBENCH_USER
}

function draftKey(userKey: string) {
  return `session:${encodeURIComponent(workbenchDraftUserKey(userKey))}`
}

function isWorkbenchDraft(value: unknown, userKey: string): value is WorkbenchDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<WorkbenchDraft>
  return (
    draft.version === WORKBENCH_DRAFT_VERSION &&
    draft.userKey === userKey &&
    typeof draft.savedAt === 'number' &&
    Boolean(draft.experiment && draft.candidate && draft.selection && draft.layout)
  )
}

export async function loadWorkbenchDraft(userKey: string) {
  const normalizedUserKey = workbenchDraftUserKey(userKey)
  const key = draftKey(normalizedUserKey)
  const stored = await get<unknown>(key, draftsStore)
  if (stored === undefined) return null
  if (isWorkbenchDraft(stored, normalizedUserKey)) return stored
  await del(key, draftsStore)
  return null
}

export function saveWorkbenchDraft(draft: WorkbenchDraft) {
  const userKey = workbenchDraftUserKey(draft.userKey)
  const storedDraft = userKey === draft.userKey ? draft : { ...draft, userKey }
  return set(draftKey(userKey), storedDraft, draftsStore)
}

export function clearWorkbenchDraft(userKey: string) {
  return del(draftKey(userKey), draftsStore)
}
