// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkbenchDraft } from '../types'
import {
  clearWorkbenchDraft,
  loadWorkbenchDraft,
  saveWorkbenchDraft,
  WORKBENCH_DRAFT_STORAGE_KEY,
} from './draftStorage'

function draft(): WorkbenchDraft {
  return {
    version: 10,
    savedAt: 1,
    experiment: { record: null, baselineBundle: null, document: null, name: '', description: '' },
    candidate: { vars: null, materialParameters: null },
    selection: { measurementId: null },
    geometry: {
      drafts: {},
      stagedModules: [],
      selectedCoordinate: 'geometry.tsx',
      selectedExport: null,
      expandedPaths: ['geometry.tsx'],
    },
    layout: { openTabs: ['experiment'], activeTab: 'experiment', experimentFile: 'geometry.tsx', splitPercent: 50 },
  }
}

beforeEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('Workbench sessionStorage v10', () => {
  it('stores and restores the single session draft, including local Geometry', async () => {
    const coordinate = 'caemble:geometry/local/common/part@local' as const
    const value: WorkbenchDraft = {
      ...draft(),
      geometry: {
        ...draft().geometry,
        drafts: {
          [coordinate]: {
            draftId: 'part',
            coordinate,
            source:
              "import { type Geometry } from '@caemble/core'\nexport const Part: Geometry = () => <box size={[1, 1, 1]} />",
            description: '',
            baseGeometryVersionId: null,
            repository: 'common',
            packageName: 'part',
            repositoryId: null,
            packageId: null,
            version: '0.1.0',
            bump: 'patch',
            standalonePreview: true,
          },
        },
        selectedCoordinate: coordinate,
        selectedExport: 'Part',
      },
      layout: {
        ...draft().layout,
        openTabs: ['experiment', 'ai-helper'],
        activeTab: 'ai-helper',
      },
    }

    await saveWorkbenchDraft(value)

    expect(sessionStorage).toHaveLength(1)
    await expect(loadWorkbenchDraft()).resolves.toEqual(value)
  })

  it('removes malformed JSON instead of restoring it', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, '{not-json')

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('does not read or migrate an older draft version', async () => {
    sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify({ ...draft(), version: 9 }))

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
    expect(sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('surfaces session quota failures to the caller', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError')
    })

    await expect(saveWorkbenchDraft(draft())).rejects.toThrow('quota exceeded')
  })

  it('clears the one fixed session key', async () => {
    await saveWorkbenchDraft(draft())
    await clearWorkbenchDraft()

    await expect(loadWorkbenchDraft()).resolves.toBeNull()
  })
})
