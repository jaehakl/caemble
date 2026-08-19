// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExperimentSourceBundle } from '@/lib/defaultExperimentCode'
import { createGeometrySnapshot, geometryModuleHash, geometrySourceHash } from '@/lib/cad'
import type { SavedExperiment } from '../types'
import { useCaeWorkbenchState } from './useCaeWorkbenchState'
import { starterExperimentSourceBundle } from '@/lib/localExperimentCode'

const mocks = vi.hoisted(() => ({
  agentGeometryContextVersion: vi.fn(),
  cadSourceHash: vi.fn(),
  cadWorkspace: vi.fn(),
  experimentList: vi.fn(),
  setCurrentExperimentId: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}))

const controller = {
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
    Measurement: { listRows: vi.fn() },
    RecordedData: { listRows: vi.fn() },
  },
  getListRequest: (scope: string, selectedIds: number[] = []) => ({
    filter: {},
    limit: 24,
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
vi.mock('@/features/viewer/workspace/useCadWorkspace', () => ({
  useCadWorkspace: (...args: unknown[]) => {
    mocks.cadWorkspace(...args)
    return { experimentDocument: controller, simulation: {} }
  },
}))
vi.mock('@/lib/cad', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cad')>()),
  cadSourceHash: mocks.cadSourceHash,
}))
vi.mock('../agent/agentWorkspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agentWorkspace')>()),
  agentGeometryContextVersion: mocks.agentGeometryContextVersion,
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: mocks.toastInfo, success: mocks.toastSuccess } }))
vi.mock('@/features/cae-workbench/measurement/useCaeMeasurementActions', () => ({
  useCaeMeasurementActions: () => ({
    busy: false,
    cancel: vi.fn(),
    cancelable: false,
    duplicateMeasurement: vi.fn(),
    error: null,
    generateCandidate: vi.fn(),
    operation: null,
    pendingRecordMeasurementId: null,
    retryRecord: vi.fn(),
    runSelected: vi.fn(),
    saveCurrent: vi.fn(),
    stage: null,
  }),
}))

const sourceHash = 'a'.repeat(64)
function experiment(id: number, name = `Experiment ${id}`): SavedExperiment {
  return {
    id,
    user_id: 'user-1',
    parent_id: null,
    name,
    description: null,
    source_bundle: defaultExperimentSourceBundle,
    source_hash: sourceHash,
  }
}

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cadSourceHash.mockImplementation(async (document: { sourceBundle: typeof defaultExperimentSourceBundle }) => {
    if (document.sourceBundle.geometrySnapshot.modules.length > 0) return 'staged-snapshot'
    return document.sourceBundle.files['experiment.tsx'] === defaultExperimentSourceBundle.files['experiment.tsx']
      ? 'base-v1'
      : 'staged-v1'
  })
  mocks.agentGeometryContextVersion.mockResolvedValue('geometry-v1')
})

describe('useCaeWorkbenchState', () => {
  it('owns a single Experiment and emits a v9 session draft', () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })

    act(() => result.current.applyExperiment(experiment(7)))

    expect(result.current.experimentId).toBe(7)
    expect(result.current.agentWorkspaceSession).toBe(1)
    expect(result.current.experimentRecord?.source_hash).toBe(sourceHash)
    expect(result.current).not.toHaveProperty('structureId')
    expect(result.current).not.toHaveProperty('pairClean')
    expect(
      result.current.draft({
        openTabs: ['experiment', 'recorded-data'],
        activeTab: 'experiment',
        experimentFile: 'experiment.tsx',
        splitPercent: 50,
      }),
    ).toMatchObject({
      version: 10,
      experiment: { record: { id: 7 } },
      candidate: { vars: null, materialParameters: null },
      selection: { measurementId: null },
      geometry: {
        drafts: {},
        stagedModules: [],
        selectedCoordinate: 'geometry.tsx',
        selectedExport: 'Conductor',
        expandedPaths: ['geometry.tsx'],
      },
    })
  })

  it('does not let an older load overwrite a newer Experiment', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise((resolve) => {
      resolveOld = resolve
    })
    mocks.experimentList.mockReturnValueOnce(old).mockResolvedValueOnce({ total: 1, items: [experiment(2)] })
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })

    let oldLoad!: Promise<SavedExperiment>
    await act(async () => {
      oldLoad = result.current.loadExperiment(1)
      await result.current.loadExperiment(2)
    })
    expect(result.current.experimentId).toBe(2)

    await act(async () => {
      resolveOld({ total: 1, items: [experiment(1)] })
      await oldLoad
    })
    expect(result.current.experimentId).toBe(2)
  })

  it('treats a newly opened local template as the clean baseline and becomes dirty after editing', () => {
    const { result } = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: wrapper() })

    act(() => result.current.newExperiment(starterExperimentSourceBundle, 'Starter Experiment'))
    expect(result.current.experimentDirty).toBe(false)
    expect(result.current.hasUnsavedWork).toBe(false)

    act(() => result.current.geometry.updateSource(`${starterExperimentSourceBundle.files['geometry.tsx']}\n// edited`))
    expect(result.current.experimentDirty).toBe(true)
    expect(result.current.hasUnsavedWork).toBe(true)
  })

  it('stores and announces Candidate vars automatically regenerated for an edited schema', () => {
    const { result } = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: wrapper() })
    const options = mocks.cadWorkspace.mock.calls[mocks.cadWorkspace.mock.calls.length - 1][2] as {
      onCandidateVarsRegenerated: (event: { reason: 'schema-changed'; vars: { openness: number } }) => void
    }

    act(() => options.onCandidateVarsRegenerated({ reason: 'schema-changed', vars: { openness: 0.5 } }))

    expect(result.current.candidateVars).toEqual({ openness: 0.5 })
    expect(mocks.toastInfo).toHaveBeenCalledWith('varsSchema가 변경되어 모든 Candidate 변수를 새로 생성했습니다.')
  })

  it('uses the strict vars policy while a persisted Measurement is selected or restoring', () => {
    const { result } = renderHook(() => useCaeWorkbenchState(null, false), { wrapper: wrapper() })
    expect(mocks.cadWorkspace.mock.calls[mocks.cadWorkspace.mock.calls.length - 1][2]).toMatchObject({
      candidateProvenance: 'editable',
    })

    act(() => result.current.restoreSelection(17))

    expect(mocks.cadWorkspace.mock.calls[mocks.cadWorkspace.mock.calls.length - 1][2]).toMatchObject({
      candidateVarsPending: true,
      candidateProvenance: 'persisted-measurement',
    })
  })

  it('applies one hash-guarded Agent bundle and can undo the complete change', async () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })
    act(() => result.current.applyExperiment(experiment(7)))
    const changedSource = `${defaultExperimentSourceBundle.files['experiment.tsx']}\n// changed by agent`
    const finalBundle = {
      ...defaultExperimentSourceBundle,
      files: { ...defaultExperimentSourceBundle.files, 'experiment.tsx': changedSource },
    }
    await act(async () => {
      const applied = await result.current.applyAgentBundle({
        runId: 'run-1',
        finalBundle,
        baseHash: 'base-v1',
        sourceHash: 'staged-v1',
        stagedRevision: 1,
        geometryContextVersion: 'geometry-v1',
      })
      expect(applied).toMatchObject({ status: 'applied', firstChangedFile: 'experiment.tsx', changedFiles: 1 })
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe(changedSource)
    expect(result.current.agentChange?.files).toHaveLength(1)

    await act(async () => {
      expect(await result.current.undoAgentChange()).toBe(true)
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe(
      defaultExperimentSourceBundle.files['experiment.tsx'],
    )
    expect(result.current.agentChange).toBeNull()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('AI Agent 변경을 되돌렸습니다.')
  })

  it('preserves the current Experiment when the Agent base hash is stale', async () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })
    act(() => result.current.applyExperiment(experiment(7)))
    const finalBundle = {
      ...defaultExperimentSourceBundle,
      files: { ...defaultExperimentSourceBundle.files, 'experiment.tsx': '// stale' },
    }

    await act(async () => {
      expect(
        await result.current.applyAgentBundle({
          runId: 'run-1',
          finalBundle,
          baseHash: 'old-base',
          sourceHash: 'staged-v1',
          stagedRevision: 1,
          geometryContextVersion: 'geometry-v1',
        }),
      ).toMatchObject({ status: 'conflicted', firstChangedFile: 'experiment.tsx', changedFiles: 1 })
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe(
      defaultExperimentSourceBundle.files['experiment.tsx'],
    )
    expect(result.current.agentChange).toMatchObject({
      status: 'conflicted',
      files: [{ path: 'experiment.tsx', after: '// stale' }],
    })
    await act(async () => {
      expect(await result.current.undoAgentChange()).toBe(true)
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe(
      defaultExperimentSourceBundle.files['experiment.tsx'],
    )
    expect(result.current.agentChange).toBeNull()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('AI Agent staged diff를 닫았습니다.')
  })

  it('applies and undoes an unvalidated snapshot-only Agent change', async () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })
    act(() => result.current.applyExperiment(experiment(7)))
    const source = 'export const Part = () => <box />'
    const coordinate = 'caemble:geometry/user/repository/part@1.0.0' as const
    const sourceHash = await geometrySourceHash(source)
    const moduleWithoutHash = {
      geometryVersionId: 1,
      coordinate,
      moduleFormatVersion: 4 as const,
      cadApiVersion: 7 as const,
      description: null,
      source,
      sourceHash,
      imports: [],
    }
    const module = { ...moduleWithoutHash, moduleHash: await geometryModuleHash(moduleWithoutHash) }
    const geometrySnapshot = createGeometrySnapshot(
      [
        {
          exportName: 'Part',
          alias: 'Part',
          geometryVersionId: 1,
          coordinate,
          moduleHash: module.moduleHash,
        },
      ],
      [module],
    )
    const finalBundle = { ...defaultExperimentSourceBundle, geometrySnapshot }

    await act(async () => {
      expect(
        await result.current.applyAgentBundle({
          runId: 'run-snapshot',
          finalBundle,
          baseHash: 'base-v1',
          sourceHash: 'staged-snapshot',
          stagedRevision: 0,
          geometryContextVersion: 'geometry-v1',
        }),
      ).toMatchObject({ status: 'applied', firstChangedFile: 'geometry.tsx', changedFiles: 0 })
    })
    expect(result.current.experiment?.sourceBundle.geometrySnapshot.modules).toHaveLength(1)
    expect(result.current.geometry.currentSnapshot.modules).toHaveLength(1)

    await act(async () => {
      expect(await result.current.undoAgentChange()).toBe(true)
    })
    expect(result.current.experiment?.sourceBundle.geometrySnapshot.modules).toHaveLength(0)
    expect(result.current.geometry.currentSnapshot.modules).toHaveLength(0)
  })

  it('applies syntax-invalid source when the bundle structure and hashes are valid', async () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })
    act(() => result.current.applyExperiment(experiment(7)))
    const generatedBundle = {
      ...defaultExperimentSourceBundle,
      files: { ...defaultExperimentSourceBundle.files, 'experiment.tsx': 'export default <broken' },
    }
    await act(async () => {
      expect(
        await result.current.applyAgentBundle({
          runId: 'run-1',
          finalBundle: generatedBundle,
          baseHash: 'base-v1',
          sourceHash: 'staged-v1',
          stagedRevision: 1,
          geometryContextVersion: 'geometry-v1',
        }),
      ).toMatchObject({ status: 'applied', firstChangedFile: 'experiment.tsx' })
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe('export default <broken')
  })

  it('blocks a completed bundle with a different source hash', async () => {
    const { result } = renderHook(() => useCaeWorkbenchState({ id: 'user-1', roles: ['user'] } as never, true), {
      wrapper: wrapper(),
    })
    act(() => result.current.applyExperiment(experiment(7)))
    const finalBundle = {
      ...defaultExperimentSourceBundle,
      files: { ...defaultExperimentSourceBundle.files, 'experiment.tsx': '// mismatched hash' },
    }
    await act(async () => {
      await expect(
        result.current.applyAgentBundle({
          runId: 'run-mismatch',
          finalBundle,
          baseHash: 'base-v1',
          sourceHash: 'other-source',
          stagedRevision: 1,
          geometryContextVersion: 'geometry-v1',
        }),
      ).resolves.toMatchObject({ status: 'conflicted', message: expect.stringContaining('source hash') })
    })
    expect(result.current.experiment?.sourceBundle.files['experiment.tsx']).toBe(
      defaultExperimentSourceBundle.files['experiment.tsx'],
    )
  })
})
