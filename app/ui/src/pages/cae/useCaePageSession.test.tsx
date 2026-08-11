// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import type { WorkbenchDraft } from '@/features/cae-workbench/types'
import { useCaePageSession } from './useCaePageSession'

const mocks = vi.hoisted(() => ({
  loadDraft: vi.fn(),
  saveDraft: vi.fn(),
  structureRows: vi.fn(),
  experimentRows: vi.fn(),
  measurementRows: vi.fn(),
}))

vi.mock('@/api', () => ({
  dbTables: {
    Structure: { listRows: mocks.structureRows },
    Experiment: { listRows: mocks.experimentRows },
    Measurement: { listRows: mocks.measurementRows },
  },
  getListRequest: () => ({ offset: 0, limit: null }),
}))

vi.mock('@/features/cae-workbench/storage/draftStorage', () => ({
  loadWorkbenchDraft: mocks.loadDraft,
  saveWorkbenchDraft: mocks.saveDraft,
  workbenchDraftUserKey: (userId: string | null | undefined) => `user:${userId ?? 'anonymous'}`,
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

function savedDraft(): WorkbenchDraft {
  const sourceBundle = {
    formatVersion: 1 as const,
    files: {
      'experiment.tsx': 'experiment source',
      'simulate.py': 'simulation source',
    },
  }
  return {
    version: 1,
    savedAt: 1,
    userKey: 'user:tester',
    structure: {
      record: { id: 10, user_id: 'tester', name: 'Beam', code: 'structure source' },
      baselineCode: 'structure source',
      document: null,
      name: 'Beam',
      description: '',
    },
    experiment: {
      record: { id: 20, user_id: 'tester', name: 'Compression', source_bundle: sourceBundle },
      baselineBundle: sourceBundle,
      document: null,
      name: 'Compression',
      description: '',
    },
    selection: { sampleId: null, setupId: null, measurementId: null },
    layout: {
      openTabs: [],
      activeTab: null,
      experimentFile: 'experiment.tsx',
      splitPercent: 50,
    },
  }
}

function fakeWorkbench() {
  const draft = savedDraft()
  return {
    structureId: 10,
    experimentId: 20,
    structureDirty: false,
    experimentDirty: false,
    pairDirty: false,
    selectionIds: { sampleId: null, setupId: null, measurementId: null },
    selectionRestoring: false,
    selection: {
      sample: null,
      setup: null,
      measurement: null,
      clearAll: vi.fn(),
    },
    measurementActions: {
      busy: false,
      performMeasurement: vi.fn(),
    },
    restoreDraft: vi.fn(),
    restoreStaleDraft: vi.fn(),
    restoreSelection: vi.fn(),
    loadResearch: vi.fn().mockResolvedValue(undefined),
    loadStructure: vi.fn().mockResolvedValue(undefined),
    loadExperiment: vi.fn().mockResolvedValue(undefined),
    applyStructure: vi.fn(),
    applyExperiment: vi.fn(),
    newStructure: vi.fn(),
    newExperiment: vi.fn(),
    draft: vi.fn(() => draft),
  } as unknown as CaeWorkbenchState
}

function SessionStatus({ workbench }: { workbench: CaeWorkbenchState }) {
  const session = useCaePageSession(false, 'tester', workbench)
  return <span>{session.initialized ? 'ready' : 'loading'}</span>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  mocks.loadDraft.mockResolvedValue(null)
  mocks.saveDraft.mockResolvedValue(undefined)
  mocks.structureRows.mockResolvedValue({ total: 0, items: [] })
  mocks.experimentRows.mockResolvedValue({ total: 0, items: [] })
  mocks.measurementRows.mockResolvedValue({ total: 0, items: [] })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('CAE page session recovery', () => {
  it('finishes initialization in StrictMode but never autosaves when IndexedDB cannot be read', async () => {
    const workbench = fakeWorkbench()
    mocks.loadDraft.mockRejectedValue(new Error('IndexedDB unavailable'))
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/cae']}>
          <SessionStatus workbench={workbench} />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    await new Promise((resolve) => window.setTimeout(resolve, 550))
    expect(mocks.saveDraft).not.toHaveBeenCalled()
  })

  it('restores an already-read draft when URL loading fails instead of autosaving empty state', async () => {
    const workbench = fakeWorkbench()
    const draft = savedDraft()
    mocks.loadDraft.mockResolvedValue(draft)
    vi.mocked(workbench.loadResearch).mockRejectedValue(new Error('network unavailable'))
    render(
      <MemoryRouter initialEntries={['/cae?structure=30&experiment=40']}>
        <SessionStatus workbench={workbench} />
      </MemoryRouter>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(draft)
  })

  it('keeps a same-pair draft and applies only the URL selection', async () => {
    const workbench = fakeWorkbench()
    const draft = savedDraft()
    mocks.loadDraft.mockResolvedValue(draft)
    mocks.structureRows.mockResolvedValue({ total: 1, items: [draft.structure.record] })
    mocks.experimentRows.mockResolvedValue({
      total: 1,
      items: [
        {
          ...draft.experiment.record,
          source_bundle: {
            formatVersion: 1,
            files: {
              'simulate.py': 'simulation source',
              'experiment.tsx': 'experiment source',
            },
          },
        },
      ],
    })
    render(
      <MemoryRouter initialEntries={['/cae?structure=10&experiment=20&measurement=33']}>
        <SessionStatus workbench={workbench} />
      </MemoryRouter>,
    )

    expect(await screen.findByText('ready')).toBeInTheDocument()
    expect(workbench.loadResearch).not.toHaveBeenCalled()
    expect(workbench.restoreDraft).toHaveBeenLastCalledWith(draft)
    expect(workbench.restoreSelection).toHaveBeenCalledWith(
      { sampleId: null, setupId: null, measurementId: 33 },
      { structureId: 10, experimentId: 20 },
    )
  })

  it('applies an external selection-only URL change without reloading clean source files', async () => {
    const workbench = fakeWorkbench()
    const router = createMemoryRouter([{ path: '/cae', element: <SessionStatus workbench={workbench} /> }], {
      initialEntries: ['/cae?structure=10&experiment=20'],
    })
    render(<RouterProvider router={router} />)
    expect(await screen.findByText('ready')).toBeInTheDocument()
    vi.mocked(workbench.loadResearch).mockClear()

    await act(async () => {
      await router.navigate('/cae?structure=10&experiment=20&measurement=33')
    })

    await waitFor(() =>
      expect(workbench.restoreSelection).toHaveBeenCalledWith(
        { sampleId: null, setupId: null, measurementId: 33 },
        { structureId: 10, experimentId: 20 },
      ),
    )
    expect(workbench.loadResearch).not.toHaveBeenCalled()
  })
})
