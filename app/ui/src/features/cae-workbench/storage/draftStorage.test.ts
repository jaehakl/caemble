// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '@/lib/cad'
import type { WorkbenchDraft } from '../types'
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WORKBENCH_DRAFT_STORAGE_KEY,
  WORKBENCH_DRAFT_VERSION,
} from './draftStorage'

const sourceBundle = createExperimentSourceBundle({
  'experiment.tsx': 'export default experiment({})',
  'geometry.tsx': 'export {}',
  'material.tsx': 'export {}',
  'simulate.py': 'async def simulate(*, sim, tasks, vars): pass',
  'lib/profile.ts': 'export const profile = [1, 2, 3]',
})

function draft(): WorkbenchDraft {
  return {
    version: 14,
    savedAt: 1,
    experiment: {
      record: null,
      baselineBundle: sourceBundle,
      document: createCadSourceDocument('experiment', sourceBundle),
      name: 'Taskless Experiment',
      description: '',
    },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    layout: {
      openTabs: ['experiment', 'experiments'],
      activeTab: 'experiment',
      experimentFile: 'lib/profile.ts',
      splitPercent: 50,
    },
  }
}

beforeEach(() => sessionStorage.clear())

describe('Workbench sessionStorage v14', () => {
  it('stores and restores the complete files-only source bundle', async () => {
    await saveWorkbenchDraft(draft())
    const restored = await loadWorkbenchDraft()

    expect(WORKBENCH_DRAFT_VERSION).toBe(14)
    expect(restored).toEqual(draft())
    expect(restored?.experiment.document?.sourceBundle.files['lib/profile.ts']).toContain('profile')
  })

  it('fully resets a v13 draft instead of migrating Geometry Manager state', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify({ ...draft(), version: 13 }))

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('clears invalid JSON and explicit drafts', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, '{')
    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    await saveWorkbenchDraft(draft())
    await clearWorkbenchDraft()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })
})
