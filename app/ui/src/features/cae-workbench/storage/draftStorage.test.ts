// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle } from '@/lib/cad'
import {
  defaultWorkbenchLayoutState,
  type WorkbenchDraft,
  type WorkbenchDraftV14,
  type WorkbenchDraftV15,
} from '../types'
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
    version: 16,
    savedAt: 1,
    experiment: {
      record: null,
      baselineBundle: sourceBundle,
      document: createCadSourceDocument('experiment', sourceBundle),
      name: 'Taskless Experiment',
      description: '',
    },
    candidate: { vars: { load: 3 }, materialParameters: null },
    selection: { measurementId: 12 },
    layout: {
      ...defaultWorkbenchLayoutState,
      activeExperimentFile: 'lib/profile.ts',
      materialId: 7,
      rightTabs: { ...defaultWorkbenchLayoutState.rightTabs },
      help: { ...defaultWorkbenchLayoutState.help },
    },
  }
}

function v15Draft(): WorkbenchDraftV15 {
  const current = draft()
  return {
    version: 15,
    savedAt: current.savedAt,
    experiment: current.experiment,
    candidate: current.candidate,
    selection: current.selection,
    layout: {
      ...current.layout,
      leftWidthPx: 420,
      rightWidthPx: 720,
      bottomHeightPx: 480,
    },
  }
}

function v14Draft(activeTab: WorkbenchDraftV14['layout']['activeTab']): WorkbenchDraftV14 {
  const current = draft()
  return {
    version: 14,
    savedAt: current.savedAt,
    experiment: current.experiment,
    candidate: current.candidate,
    selection: current.selection,
    layout: {
      openTabs: ['experiment', 'experiments', 'recorded-data', 'ai-helper'],
      activeTab,
      experimentFile: 'lib/profile.ts',
      splitPercent: 56,
    },
  }
}

beforeEach(() => sessionStorage.clear())

describe('Workbench sessionStorage v16', () => {
  it('stores and restores the complete source and session layout', async () => {
    await saveWorkbenchDraft(draft())
    const restored = await loadWorkbenchDraft()

    expect(WORKBENCH_DRAFT_VERSION).toBe(16)
    expect(restored).toEqual(draft())
    expect(restored?.experiment.document?.sourceBundle.files['lib/profile.ts']).toContain('profile')
  })

  it('migrates a v14 RecordedData tab without losing domain or source data', async () => {
    const legacy = v14Draft('recorded-data')
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy))

    const restored = await loadWorkbenchDraft()

    expect(restored?.version).toBe(16)
    expect(restored?.experiment).toEqual(legacy.experiment)
    expect(restored?.candidate).toEqual(legacy.candidate)
    expect(restored?.selection).toEqual(legacy.selection)
    expect(restored?.layout).toMatchObject({
      activeSection: 'measurement',
      activeExperimentFile: 'lib/profile.ts',
      bottomMode: 'hidden',
    })
    expect(restored?.layout).not.toHaveProperty('openTabs')
    expect(restored?.layout).not.toHaveProperty('splitPercent')
    expect(JSON.parse(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY) ?? '{}')).toEqual(restored)
  })

  it('restores the former AI Helper tab as the persistent AI Agent dock', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(v14Draft('ai-helper')))

    const restored = await loadWorkbenchDraft()

    expect(restored?.layout.activeSection).toBe('experiment')
    expect(restored?.layout.bottomMode).toBe('agent')
  })

  it('migrates v15 content while resetting pixel dimensions to the ratio defaults', async () => {
    const legacy = v15Draft()
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(legacy))

    const restored = await loadWorkbenchDraft()

    expect(restored?.version).toBe(16)
    expect(restored?.experiment).toEqual(legacy.experiment)
    expect(restored?.layout).toMatchObject({
      activeExperimentFile: 'lib/profile.ts',
      materialId: 7,
      leftWidthRatio: defaultWorkbenchLayoutState.leftWidthRatio,
      rightWidthRatio: defaultWorkbenchLayoutState.rightWidthRatio,
      bottomHeightRatio: defaultWorkbenchLayoutState.bottomHeightRatio,
    })
    expect(restored?.layout).not.toHaveProperty('leftWidthPx')
    expect(restored?.layout).not.toHaveProperty('rightWidthPx')
    expect(restored?.layout).not.toHaveProperty('bottomHeightPx')
    expect(JSON.parse(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY) ?? '{}')).toEqual(restored)
  })

  it('normalizes invalid v16 layout fields independently while retaining valid source data', async () => {
    const invalid = {
      ...draft(),
      layout: {
        activeSection: 'unknown',
        activeExperimentFile: 42,
        materialId: -9,
        leftWidthRatio: -1,
        rightWidthRatio: null,
        bottomMode: 'large',
        bottomHeightRatio: 9,
        rightTabs: { experiment: 'unknown', measurement: 'detail' },
        analysisTab: 'prediction',
        help: { kind: 'solvers', item: 9 },
      },
    }
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(invalid))

    const restored = await loadWorkbenchDraft()

    expect(restored?.experiment.document?.sourceBundle.files['lib/profile.ts']).toContain('profile')
    expect(restored?.layout).toEqual({
      activeSection: 'experiment',
      activeExperimentFile: 'experiment.tsx',
      materialId: null,
      leftWidthRatio: 0,
      rightWidthRatio: defaultWorkbenchLayoutState.rightWidthRatio,
      bottomMode: 'console',
      bottomHeightRatio: 1,
      viewerExpanded: false,
      rightTabs: { experiment: 'source', measurement: 'detail' },
      analysisTab: 'prediction',
      help: { kind: 'solvers', item: 'program-overview' },
    })
  })

  it('fully resets unsupported drafts instead of carrying obsolete layout state', async () => {
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
