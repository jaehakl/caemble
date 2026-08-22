// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dbTables } from '@/api'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { useCaePageSession } from './useCaePageSession'

const mocks = vi.hoisted(() => ({
  loadDraft: vi.fn(async () => null),
  saveDraft: vi.fn(async () => undefined),
  toastError: vi.fn(),
}))

vi.mock('@/features/cae-workbench/storage/draftStorage', () => ({
  loadWorkbenchDraft: mocks.loadDraft,
  saveWorkbenchDraft: mocks.saveDraft,
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

function workbench(overrides: Record<string, unknown> = {}) {
  return {
    applyExperiment: vi.fn(),
    draft: vi.fn(() => ({ version: 14 })),
    experimentDirty: false,
    hasUnsavedWork: false,
    hasUnsavedExperimentWork: false,
    experimentId: null,
    loadExperiment: vi.fn().mockResolvedValue(undefined),
    measurementActions: {
      busy: false,
      error: null,
      pendingRecordMeasurementId: null,
      runSelected: vi.fn(() => 'run-1'),
    },
    newExperiment: vi.fn(),
    restoreDraft: vi.fn(),
    restoreSelection: vi.fn(),
    saving: null,
    selection: {
      clearMeasurement: vi.fn(),
      loadMeasurement: vi.fn().mockResolvedValue(undefined),
    },
    selectionIds: { measurementId: null },
    selectionRestoring: false,
    ...overrides,
  } as unknown as CaeWorkbenchState
}

function wrapper(initialEntry = '/') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mocks.loadDraft.mockResolvedValue(null)
  mocks.saveDraft.mockResolvedValue(undefined)
})

describe('useCaePageSession', () => {
  it('restores only Experiment and Measurement from the URL', async () => {
    const state = workbench()
    const { result } = renderHook(() => useCaePageSession(state), {
      wrapper: wrapper('/?experiment=7&measurement=11&structure=2&sample=3&setup=4'),
    })

    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(state.loadExperiment).toHaveBeenCalledWith(7, 11)
    expect(state.restoreSelection).not.toHaveBeenCalledWith(expect.objectContaining({ sampleId: 3 }))
  })

  it('opens the associated Experiment for a Measurement-only deep link', async () => {
    vi.spyOn(dbTables.Measurement, 'listRows').mockResolvedValue({
      total: 1,
      items: [
        {
          id: 11,
          experiment_id: 7,
          vars: {},
          material_parameters: {
            schemaVersion: 2,
            experiment: { schemaVersion: 1, materials: {} },
            tasks: { main: { schemaVersion: 1, materials: {} } },
          },
          recorded_at: null,
        },
      ],
    })
    const state = workbench()
    const { result } = renderHook(() => useCaePageSession(state), {
      wrapper: wrapper('/?measurement=11'),
    })

    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(state.loadExperiment).toHaveBeenCalledWith(7, 11)
  })

  it('initializes the local Starter immediately with Experiment as the active tab', async () => {
    const state = workbench()
    const { result } = renderHook(() => useCaePageSession(state), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.initialized).toBe(true))
    expect(state.restoreDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 14,
        experiment: expect.objectContaining({
          name: 'Starter Experiment',
          baselineBundle: expect.objectContaining({ files: expect.any(Object) }),
          document: expect.objectContaining({ sourceBundle: expect.any(Object) }),
        }),
        candidate: { vars: null, materialParameters: null },
        selection: { measurementId: null },
        layout: expect.objectContaining({ activeTab: 'experiment' }),
      }),
    )
    expect(result.current.activeTab).toBe('experiment')
  })

  it('guards replacement when the Experiment source is dirty', async () => {
    const state = workbench({ experimentDirty: true, hasUnsavedWork: true, hasUnsavedExperimentWork: true })
    const { result } = renderHook(() => useCaePageSession(state), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.initialized).toBe(true))
    const replace = vi.fn()

    act(() => result.current.guardReplacement(replace))

    expect(replace).not.toHaveBeenCalled()
    expect(result.current.confirmation?.title).toContain('저장하지 않은 편집')
  })

  it('does not guard replacement when the Experiment source is clean', async () => {
    const state = workbench({ hasUnsavedWork: false, hasUnsavedExperimentWork: false })
    const { result } = renderHook(() => useCaePageSession(state), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.initialized).toBe(true))
    const replace = vi.fn()

    act(() => result.current.guardReplacement(replace))

    await waitFor(() => expect(replace).toHaveBeenCalledOnce())
    expect(result.current.confirmation).toBeNull()
  })

  it('keeps a session result in place until its RecordedData save is retried', async () => {
    const state = workbench({
      measurementActions: {
        busy: false,
        error: 'record failed',
        pendingRecordMeasurementId: 11,
        runSelected: vi.fn(),
      },
    })
    const { result } = renderHook(() => useCaePageSession(state), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.initialized).toBe(true))
    const replace = vi.fn()

    act(() => result.current.guardReplacement(replace))

    expect(replace).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringContaining('결과 저장을 다시 시도'))
  })

  it('runs the selected prepared Measurement without overwrite preflight', async () => {
    const runSelected = vi.fn(() => 'run-1')
    const state = workbench({
      measurementActions: { busy: false, error: null, pendingRecordMeasurementId: null, runSelected },
    })
    const { result } = renderHook(() => useCaePageSession(state), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.initialized).toBe(true))

    act(() => result.current.requestRunSelected())
    expect(runSelected).toHaveBeenCalledOnce()
  })

  it('keeps layout and the current draft mounted when authentication state changes above it', async () => {
    const anonymousState = workbench()
    const signedInState = workbench()
    const { result, rerender } = renderHook(({ state }: { state: CaeWorkbenchState }) => useCaePageSession(state), {
      initialProps: { state: anonymousState },
      wrapper: wrapper(),
    })
    await waitFor(() => expect(result.current.initialized).toBe(true))
    act(() => result.current.openTab('ai-helper'))

    rerender({ state: signedInState })

    expect(result.current.activeTab).toBe('ai-helper')
    expect(result.current.openTabs).toContain('ai-helper')
    expect(mocks.loadDraft).toHaveBeenCalledOnce()
    expect(signedInState.restoreDraft).not.toHaveBeenCalled()
  })
})
