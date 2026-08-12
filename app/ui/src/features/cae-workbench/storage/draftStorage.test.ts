import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchDraft } from '../types'

const indexedDb = vi.hoisted(() => {
  const values = new Map<IDBValidKey, unknown>()
  return {
    values,
    createStore: vi.fn(() => ({ dbName: 'caemble', storeName: 'cae-workbench-drafts' })),
    del: vi.fn(async (key: IDBValidKey) => values.delete(key)),
    get: vi.fn(async (key: IDBValidKey) => values.get(key)),
    set: vi.fn(async (key: IDBValidKey, value: unknown) => {
      values.set(key, value)
    }),
  }
})

vi.mock('idb-keyval', () => indexedDb)

import {
  ANONYMOUS_WORKBENCH_USER,
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  workbenchDraftUserKey,
} from './draftStorage'

function makeDraft(userKey: string, savedAt: number): WorkbenchDraft {
  return {
    version: 2,
    savedAt,
    userKey,
    experiment: { record: null, baselineBundle: null, document: null, name: '', description: '' },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    layout: {
      openTabs: ['experiment'],
      activeTab: 'experiment',
      experimentFile: null,
      splitPercent: 50,
    },
  }
}

beforeEach(() => {
  indexedDb.values.clear()
  indexedDb.del.mockClear()
  indexedDb.get.mockClear()
  indexedDb.set.mockClear()
})

describe('CAE workbench draft storage', () => {
  it('keeps one latest draft in each user namespace', async () => {
    const firstAliceDraft = makeDraft('alice', 1)
    const latestAliceDraft = makeDraft('alice', 2)
    const bobDraft = makeDraft('bob', 3)

    await saveWorkbenchDraft(firstAliceDraft)
    await saveWorkbenchDraft(latestAliceDraft)
    await saveWorkbenchDraft(bobDraft)

    await expect(loadWorkbenchDraft('alice')).resolves.toEqual(latestAliceDraft)
    await expect(loadWorkbenchDraft('bob')).resolves.toEqual(bobDraft)
    expect(indexedDb.values).toHaveLength(2)
  })

  it('normalizes an empty identity to the anonymous namespace', () => {
    expect(workbenchDraftUserKey(null)).toBe(ANONYMOUS_WORKBENCH_USER)
    expect(workbenchDraftUserKey('  ')).toBe(ANONYMOUS_WORKBENCH_USER)
    expect(workbenchDraftUserKey(' user-id ')).toBe('user-id')
  })

  it('rejects and removes an incompatible stored version', async () => {
    await saveWorkbenchDraft(makeDraft('alice', 1))
    const [key] = indexedDb.values.keys()
    indexedDb.values.set(key, { ...makeDraft('alice', 1), version: 1 })

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    expect(indexedDb.del).toHaveBeenCalledWith(key, expect.anything())
  })

  it('clears only the requested user draft', async () => {
    await saveWorkbenchDraft(makeDraft('alice', 1))
    await saveWorkbenchDraft(makeDraft('bob', 2))

    await clearWorkbenchDraft('alice')

    await expect(loadWorkbenchDraft('alice')).resolves.toBeNull()
    await expect(loadWorkbenchDraft('bob')).resolves.toEqual(makeDraft('bob', 2))
  })
})
