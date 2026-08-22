// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCadSourceDocument, createExperimentSourceBundle, type ExperimentSourceDocument } from '@/lib/cad'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'
import type { SavedExperiment } from '../types'
import { useCaeWorkbenchState } from './useCaeWorkbenchState'

const mocks = vi.hoisted(() => ({
  agentContext: vi.fn(async () => 'context-v1'),
  experimentList: vi.fn(),
  saveDefinition: vi.fn(),
  setCurrentExperimentId: vi.fn(),
  sourceHash: vi.fn(async () => 'source-v1'),
  workspaceChange: vi.fn(),
}))

const controller = {
  draftTaskNames: [],
  generateCandidate: vi.fn(),
  materialParameters: null,
  revision: 1,
  runIsBusy: false,
  status: 'Ready',
  successfulRevision: -1,
  variables: null,
}

vi.mock('@/api', () => ({
  dbTables: {
    Experiment: { listRows: mocks.experimentList },
    Measurement: { listRows: vi.fn(async () => ({ total: 0, items: [] })) },
    RecordedData: { listRows: vi.fn(async () => ({ total: 0, items: [] })) },
  },
  getListRequest: (scope: string, selectedIds: number[] = []) => ({
    filter: {},
    limit: 24,
    null_filter: {},
    offset: 0,
    scope,
    search_text: null,
    selected_ids: selectedIds,
    sort: ['updated_at', 'desc'],
    text_filter: {},
  }),
}))
vi.mock('@/features/viewer/current-cad-selection', () => ({
  useCurrentCadSelection: () => ({ setCurrentExperimentId: mocks.setCurrentExperimentId }),
}))
vi.mock('@/features/viewer/persistence/saveDefinition', () => ({ saveCadDefinition: mocks.saveDefinition }))
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: (_experiment: unknown, onExperimentChange: (document: ExperimentSourceDocument) => void) => {
    mocks.workspaceChange.mockImplementation(onExperimentChange)
    return { experimentDocument: controller, simulation: {} }
  },
}))
vi.mock('@/lib/cad', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cad')>()),
  cadSourceHash: mocks.sourceHash,
}))
vi.mock('../agent/agentWorkspace', () => ({ agentExperimentContextVersion: mocks.agentContext }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))
vi.mock('../measurement/useCaeMeasurementActions', () => ({
  useCaeMeasurementActions: () => ({
    busy: false,
    cancel: vi.fn(),
    cancelable: false,
    duplicateMeasurement: vi.fn(),
    generateCandidate: vi.fn(),
    operation: null,
    pendingRecordMeasurementId: null,
    retryRecord: vi.fn(),
    saveCurrent: vi.fn(),
    stage: null,
  }),
}))

function savedExperiment(id: number, name = `Experiment ${id}`): SavedExperiment {
  return {
    id,
    user_id: 'user-1',
    namespace: 'jlee',
    repository_slug: 'examples',
    experiment_key: `experiment-${id}`,
    version_major: 1,
    version_minor: 2,
    version_patch: 3,
    name,
    description: null,
    source_bundle: starterExperimentSourceBundle,
    source_hash: 'a'.repeat(64),
    sourceLocked: false,
  }
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => vi.clearAllMocks())

describe('useCaeWorkbenchState', () => {
  it('stores a files-only v14 draft and exposes Experiment coordinate state', async () => {
    const { result } = renderHook(
      () => useCaeWorkbenchState({ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never, true),
      { wrapper: wrapper() },
    )

    act(() => result.current.applyExperiment(savedExperiment(7)))
    await waitFor(() => expect(result.current.agentWorkspaceIdentity).not.toBeNull())

    expect(result.current.experimentCoordinate).toBe('caemble:experiment/jlee/examples/experiment-7@1.2.3')
    expect(result.current.experimentVersion).toBe('1.2.3')
    expect(result.current.sourceLocked).toBe(false)
    expect(
      result.current.draft({
        openTabs: ['experiment', 'experiments'],
        activeTab: 'experiment',
        experimentFile: 'geometry.tsx',
        splitPercent: 50,
      }),
    ).toMatchObject({ version: 14, experiment: { record: { id: 7 } } })
  })

  it('allows a taskless local Experiment for preview and source saving state', () => {
    const taskless = createExperimentSourceBundle({
      'experiment.tsx': starterExperimentSourceBundle.files['experiment.tsx'],
      'geometry.tsx': starterExperimentSourceBundle.files['geometry.tsx'],
      'material.tsx': starterExperimentSourceBundle.files['material.tsx'],
      'simulate.py': starterExperimentSourceBundle.files['simulate.py'],
      'lib/profile.ts': 'export const profile = []',
    })
    const { result } = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: wrapper() })

    act(() => result.current.newExperiment(taskless, 'Preview only'))

    expect(result.current.hasTasks).toBe(false)
    expect(result.current.experimentStatus).toBe('new')
    expect(result.current.experiment?.sourceBundle.files).toHaveProperty('lib/profile.ts')
  })

  it('allows metadata overwrite on a source-locked Version but blocks changed source', async () => {
    const locked = { ...savedExperiment(7), sourceLocked: true }
    const values = {
      name: 'Renamed Experiment',
      description: 'Metadata only',
      repository: 'examples',
      key: 'experiment-7',
      bump: 'patch' as const,
    }
    mocks.saveDefinition.mockResolvedValue({
      id: 7,
      action: 'overwrite',
      namespace: 'jlee',
      repository: 'examples',
      key: 'experiment-7',
      version: '1.2.3',
      coordinate: 'caemble:experiment/jlee/examples/experiment-7@1.2.3',
      bundleHash: 'b'.repeat(64),
      sourceLocked: true,
      derivedCounts: { measurements: 1, recordedData: 0, designerModels: 0, predictorModels: 0 },
      sourceBundle: starterExperimentSourceBundle,
    })
    const { result } = renderHook(
      () => useCaeWorkbenchState({ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never, true),
      { wrapper: wrapper() },
    )

    act(() => result.current.applyExperiment(locked))
    await act(async () => {
      await result.current.saveExperiment(values, 'overwrite')
    })
    expect(mocks.saveDefinition).toHaveBeenCalledOnce()

    const changedBundle = createExperimentSourceBundle({
      ...starterExperimentSourceBundle.files,
      'geometry.tsx': 'export const Changed = () => <box size={[2, 2, 2]} />',
    })
    act(() =>
      result.current.restoreDraft({
        version: 14,
        savedAt: Date.now(),
        experiment: {
          record: locked,
          baselineBundle: starterExperimentSourceBundle,
          document: createCadSourceDocument('experiment', changedBundle),
          name: locked.name,
          description: locked.description ?? '',
        },
        candidate: { vars: null, materialParameters: null },
        selection: { measurementId: null },
        layout: { openTabs: ['experiment'], activeTab: 'experiment', experimentFile: 'geometry.tsx', splitPercent: 50 },
      }),
    )

    await expect(result.current.saveExperiment(values, 'overwrite')).rejects.toThrow(
      '연결 데이터가 있는 Version은 잠겨 있습니다.',
    )
    expect(mocks.saveDefinition).toHaveBeenCalledOnce()
  })

  it('does not let an older load overwrite a newer Experiment', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise((resolve) => {
      resolveOld = resolve
    })
    mocks.experimentList.mockReturnValueOnce(old).mockResolvedValueOnce({ total: 1, items: [savedExperiment(2)] })
    const { result } = renderHook(
      () => useCaeWorkbenchState({ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never, true),
      { wrapper: wrapper() },
    )

    let oldLoad!: Promise<SavedExperiment>
    await act(async () => {
      oldLoad = result.current.loadExperiment(1)
      await result.current.loadExperiment(2)
    })
    expect(result.current.experimentId).toBe(2)

    await act(async () => {
      resolveOld({ total: 1, items: [savedExperiment(1)] })
      await oldLoad
    })
    expect(result.current.experimentId).toBe(2)
  })

  it('attaches the saved identity while preserving edits made during an in-flight save', async () => {
    const savedBundle = starterExperimentSourceBundle
    const changedBundle = createExperimentSourceBundle({
      ...savedBundle.files,
      'geometry.tsx': 'export const Changed = () => <box size={[2, 2, 2]} />',
    })
    const saveResult = {
      id: 12,
      action: 'create' as const,
      namespace: 'jlee',
      repository: 'examples',
      key: 'in-flight',
      version: '0.1.0',
      coordinate: 'caemble:experiment/jlee/examples/in-flight@0.1.0',
      bundleHash: 'c'.repeat(64),
      sourceLocked: false,
      derivedCounts: { measurements: 0, recordedData: 0, designerModels: 0, predictorModels: 0 },
      sourceBundle: savedBundle,
    }
    let resolveSave!: (value: typeof saveResult) => void
    mocks.saveDefinition.mockReturnValue(
      new Promise<typeof saveResult>((resolve) => {
        resolveSave = resolve
      }),
    )
    const { result } = renderHook(
      () => useCaeWorkbenchState({ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never, true),
      { wrapper: wrapper() },
    )

    act(() => result.current.newExperiment(savedBundle, 'In-flight'))
    let savePromise!: Promise<unknown>
    act(() => {
      savePromise = result.current.saveExperiment(
        {
          name: 'In-flight',
          description: '',
          repository: 'examples',
          key: 'in-flight',
          bump: 'patch',
        },
        'create',
      )
    })
    act(() => mocks.workspaceChange(createCadSourceDocument('experiment', changedBundle)))
    await act(async () => {
      resolveSave(saveResult)
      await savePromise
    })

    expect(result.current.experimentRecord).toMatchObject({ id: 12, experiment_key: 'in-flight' })
    expect(result.current.experiment?.sourceBundle).toEqual(changedBundle)
    expect(result.current.experimentStatus).toBe('saved-dirty')
    expect(result.current.hasUnsavedExperimentWork).toBe(true)
  })

  it('detaches a deleted current Version while preserving its latest source as dirty work', () => {
    const changedBundle = createExperimentSourceBundle({
      ...starterExperimentSourceBundle.files,
      'geometry.tsx': 'export const Changed = () => <sphere radius={2} />',
    })
    const { result } = renderHook(
      () => useCaeWorkbenchState({ id: 'user-1', roles: ['user'], experiment_namespace: 'jlee' } as never, true),
      { wrapper: wrapper() },
    )

    act(() => result.current.applyExperiment(savedExperiment(7)))
    act(() => mocks.workspaceChange(createCadSourceDocument('experiment', changedBundle)))
    act(() => result.current.detachDeletedExperiment())

    expect(result.current.experimentRecord).toBeNull()
    expect(result.current.experimentId).toBeNull()
    expect(result.current.experiment?.sourceBundle).toEqual(changedBundle)
    expect(result.current.experimentStatus).toBe('new')
    expect(result.current.experimentDirty).toBe(true)
    expect(result.current.hasUnsavedExperimentWork).toBe(true)
  })
})
