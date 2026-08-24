// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { primitives } from '@jscad/modeling'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCadSourceDocument,
  createExperimentSourceBundle,
  evaluateDocument,
  inspectDocument,
  serializeCadScene,
  updateExperimentSourceFile,
  type Vars,
  type VarsSchemaEntry,
} from '@/lib/cad'
import { fetchCatalogRuntimeSlice } from '@/lib/catalog/references'
import { registerSourceCatalogRuntimeSlice } from '@/lib/catalog/runtime'
import { buildSyntheticCatalog, buildSyntheticSolver } from '@/test/syntheticCatalog'
import type { RuntimeActivityDraft } from '@/features/runtime-console'
import { resolveDocumentMaterials } from '../persistence/resolveMaterials'
import { useCadWorkspace } from './useCadWorkspace'

vi.mock('@/lib/cad', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cad')>()
  return { ...actual, evaluateDocument: vi.fn(), inspectDocument: vi.fn() }
})
vi.mock('@/lib/catalog/references', () => ({ fetchCatalogRuntimeSlice: vi.fn() }))
vi.mock('../persistence/resolveMaterials', () => ({ resolveDocumentMaterials: vi.fn() }))

const sourceHash = 'a'.repeat(64)
const catalog = buildSyntheticCatalog({ solvers: [buildSyntheticSolver('test', '1')] })
const draftCatalog = buildSyntheticCatalog()
const emptyMaterials = { schemaVersion: 1, materials: {} } as const
const emptyTaskConfig = { parameters: {}, initializations: [], boundaryConditions: [], outputs: [] } as const
const varsSchema = { fixed: { min: 4, max: 4 }, width: { min: 1, max: 10 } } as const
let currentVarsSchema: Readonly<Record<string, VarsSchemaEntry>> = varsSchema
const serializedScene = serializeCadScene({
  geometryGroups: [],
  lengthUnit: 'mm',
  parts: [],
  surfaceGroups: [],
  tree: { children: [], key: 'root', label: 'Root' },
})
const unresolvedScene = serializeCadScene({
  geometryGroups: [],
  lengthUnit: 'mm',
  parts: [
    {
      id: 'wheel',
      geometry: primitives.cuboid({ size: [1, 1, 1] }),
      materialRole: 'wheel',
      surfaces: [],
    },
  ],
  surfaceGroups: [],
  tree: { children: [], key: 'root', label: 'Root' },
})
const document = createCadSourceDocument(
  'experiment',
  createExperimentSourceBundle({
    'experiment.tsx': 'experiment',
    'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
    'tasks/electric.tsx': 'electric',
  }),
)

describe('useCadWorkspace unified Experiment', () => {
  beforeEach(() => {
    currentVarsSchema = varsSchema
    vi.mocked(fetchCatalogRuntimeSlice).mockResolvedValue(catalog)
    registerSourceCatalogRuntimeSlice(sourceHash, catalog)
    vi.mocked(inspectDocument).mockImplementation(async () => ({ sourceHash, varsSchema: currentVarsSchema }))
    vi.mocked(evaluateDocument).mockImplementation(async ({ vars }) => ({
      kind: 'experiment',
      scene: serializedScene,
      taskScenes: { electric: serializedScene },
      simulationProgram: {
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        tasks: { electric: { kernel: { name: 'test', version: '1' }, config: emptyTaskConfig } },
        recordedData: {},
      },
      sourceHash,
      variables: vars,
      varsSchema: currentVarsSchema,
    }))
    vi.mocked(resolveDocumentMaterials).mockResolvedValue({
      materialParameters: emptyMaterials,
      warnings: [],
      taskMaterialParameters: { electric: emptyMaterials },
      taskMaterialWarnings: { electric: [] },
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('updates Program files and adds/removes Task files through whole-document changes', () => {
    const onChange = vi.fn()
    const render = renderHook(() => useCadWorkspace(document, onChange, { candidateVars: { fixed: 4, width: 2 } }))

    act(() => render.result.current.experimentDocument.handleExperimentFileChange('simulate.py', 'changed'))
    expect(onChange.mock.calls[0][0].sourceBundle.files['simulate.py']).toBe('changed')

    act(() => render.result.current.experimentDocument.handleAddExperimentTask('thermal', 'thermal'))
    expect(onChange.mock.calls[1][0].sourceBundle.files['tasks/thermal.tsx']).toBe('thermal')

    const withTwoTasks = onChange.mock.calls[1][0]
    render.unmount()
    const removeChange = vi.fn()
    const second = renderHook(() =>
      useCadWorkspace(withTwoTasks, removeChange, { candidateVars: { fixed: 4, width: 2 } }),
    )
    act(() => second.result.current.experimentDocument.handleRemoveExperimentTask('electric'))
    expect(removeChange.mock.calls[0][0].sourceBundle.files).not.toHaveProperty('tasks/electric.tsx')
    second.unmount()
  })

  it('keeps Task scene hashes stable across render status transitions', () => {
    const render = renderHook(() => useCadWorkspace(null, undefined))
    const initialHashes = render.result.current.experimentDocument.taskSceneHashes

    act(() => render.result.current.experimentDocument.handleRenderStart())
    expect(render.result.current.experimentDocument.status).toBe('Rendering')
    expect(render.result.current.experimentDocument.taskSceneHashes).toBe(initialHashes)
    act(() => render.result.current.experimentDocument.handleRenderEnd())
    expect(render.result.current.experimentDocument.status).toBe('Ready')
    render.unmount()
  })

  it('reports typed CAD compile, evaluation, material, and render activity without changing the workspace result', async () => {
    const activities: RuntimeActivityDraft[] = []
    const render = renderHook(() =>
      useCadWorkspace(document, vi.fn(), {
        candidateVars: { fixed: 4, width: 2 },
        onActivity: (activity) => activities.push(activity),
      }),
    )

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    expect(activities.map(({ source }) => source).every((source) => source === 'cad')).toBe(true)
    expect(activities.map(({ phase }) => phase)).toEqual([
      'source.checking',
      'compile.started',
      'compile.completed',
      'evaluate.started',
      'evaluate.completed',
      'materials.resolving',
      'workspace.ready',
    ])

    act(() => render.result.current.experimentDocument.handleRenderStart())
    act(() => render.result.current.experimentDocument.handleRenderEnd())
    expect(activities.slice(-2).map(({ phase }) => phase)).toEqual(['render.started', 'render.completed'])
    render.unmount()
  })

  it('generates a new in-range candidate without changing source and keeps min == max fixed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const onChange = vi.fn()
    const render = renderHook(() =>
      useCadWorkspace(document, onChange, {
        candidateVars: { fixed: 4, width: 2 },
        frozenMaterialSnapshot: {
          schemaVersion: 2,
          experiment: emptyMaterials,
          tasks: { electric: emptyMaterials },
        },
      }),
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    act(() => render.result.current.experimentDocument.generateCandidate())
    await waitFor(() => expect(evaluateDocument).toHaveBeenCalledTimes(2))
    expect(fetchCatalogRuntimeSlice).toHaveBeenCalledOnce()
    expect(inspectDocument).toHaveBeenCalledOnce()
    expect(vi.mocked(evaluateDocument).mock.calls[1][0].document).toBe(document)
    expect(vi.mocked(evaluateDocument).mock.calls[1][0].vars).toEqual({ fixed: 4, width: 7.75 })
    expect(resolveDocumentMaterials).toHaveBeenLastCalledWith(expect.anything(), null, false)
    expect(onChange).not.toHaveBeenCalled()
    render.unmount()
  })

  it('does not reevaluate when the Workbench echoes a generated editable Candidate and material snapshot', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const initialMaterials = {
      schemaVersion: 2,
      experiment: emptyMaterials,
      tasks: { electric: emptyMaterials },
    } as const
    const render = renderHook(
      ({ candidateVars, materialSnapshot }: { candidateVars: Readonly<Vars>; materialSnapshot: unknown }) =>
        useCadWorkspace(document, vi.fn(), {
          candidateVars,
          frozenMaterialSnapshot: materialSnapshot,
        }),
      { initialProps: { candidateVars: { fixed: 4, width: 2 }, materialSnapshot: initialMaterials as unknown } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    act(() => render.result.current.experimentDocument.generateCandidate())
    await waitFor(() => expect(evaluateDocument).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(render.result.current.experimentDocument.successfulRevision).toBe(
        render.result.current.experimentDocument.revision,
      ),
    )
    const generatedVars = render.result.current.experimentDocument.variables!
    const generatedMaterials = render.result.current.experimentDocument.materialParameters

    render.rerender({
      candidateVars: generatedVars as Readonly<{ fixed: number; width: number }>,
      materialSnapshot: generatedMaterials,
    })

    expect(fetchCatalogRuntimeSlice).toHaveBeenCalledOnce()
    expect(inspectDocument).toHaveBeenCalledOnce()
    expect(evaluateDocument).toHaveBeenCalledTimes(2)
    expect(resolveDocumentMaterials).toHaveBeenCalledTimes(2)
    render.unmount()
  })

  it('evaluates each newly selected Experiment once when Candidate state is echoed by the Workbench', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const initialProps: {
      candidateVars: Readonly<Vars> | undefined
      materialSnapshot: unknown
      resetKey: number
      source: typeof document
    } = {
      candidateVars: undefined,
      materialSnapshot: null,
      resetKey: 1,
      source: document,
    }
    const render = renderHook(
      ({ candidateVars, materialSnapshot, resetKey, source }) =>
        useCadWorkspace(source, vi.fn(), {
          candidateVars,
          frozenMaterialSnapshot: materialSnapshot,
          resetKey,
        }),
      { initialProps },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    const generatedVars = render.result.current.experimentDocument.variables!
    const generatedMaterials = render.result.current.experimentDocument.materialParameters

    render.rerender({ ...initialProps, candidateVars: generatedVars, materialSnapshot: generatedMaterials })

    expect(fetchCatalogRuntimeSlice).toHaveBeenCalledOnce()
    expect(inspectDocument).toHaveBeenCalledOnce()
    expect(evaluateDocument).toHaveBeenCalledOnce()
    expect(resolveDocumentMaterials).toHaveBeenCalledOnce()

    const replacement = updateExperimentSourceFile(document, 'experiment.tsx', 'replacement')
    render.rerender({
      candidateVars: generatedVars,
      materialSnapshot: generatedMaterials,
      resetKey: 2,
      source: replacement,
    })
    await waitFor(() => expect(evaluateDocument).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(render.result.current.experimentDocument.successfulRevision).toBe(
        render.result.current.experimentDocument.revision,
      ),
    )

    render.rerender({
      candidateVars: render.result.current.experimentDocument.variables!,
      materialSnapshot: render.result.current.experimentDocument.materialParameters,
      resetKey: 2,
      source: replacement,
    })

    expect(fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(2)
    expect(inspectDocument).toHaveBeenCalledTimes(2)
    expect(evaluateDocument).toHaveBeenCalledTimes(2)
    expect(resolveDocumentMaterials).toHaveBeenCalledTimes(2)
    render.unmount()
  })

  it('keeps a valid Candidate when varsSchema only changes key order', async () => {
    const onRegenerated = vi.fn()
    const random = vi.spyOn(Math, 'random')
    const render = renderHook(
      ({ source }) =>
        useCadWorkspace(source, vi.fn(), {
          candidateVars: { fixed: 4, width: 2 },
          onCandidateVarsRegenerated: onRegenerated,
        }),
      { initialProps: { source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    currentVarsSchema = { width: varsSchema.width, fixed: varsSchema.fixed }
    render.rerender({ source: updateExperimentSourceFile(document, 'experiment.tsx', 'same schema') })

    await waitFor(() => expect(evaluateDocument).toHaveBeenCalledTimes(2))
    expect(fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(2)
    expect(inspectDocument).toHaveBeenCalledTimes(2)
    expect(vi.mocked(evaluateDocument).mock.calls[1][0].vars).toEqual({ fixed: 4, width: 2 })
    expect(onRegenerated).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    render.unmount()
  })

  it('regenerates every editable Candidate var once when varsSchema changes', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onRegenerated = vi.fn()
    const render = renderHook(
      ({ source }) =>
        useCadWorkspace(source, vi.fn(), {
          candidateVars: { fixed: 4, width: 2 },
          onCandidateVarsRegenerated: onRegenerated,
        }),
      { initialProps: { source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    currentVarsSchema = { ...varsSchema, openness: { min: 0, max: 1 } }
    render.rerender({ source: updateExperimentSourceFile(document, 'experiment.tsx', 'with openness') })

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    const generated = vi.mocked(evaluateDocument).mock.calls[1][0].vars
    expect(generated).toEqual({ fixed: 4, width: 5.5, openness: 0.5 })
    expect(onRegenerated).toHaveBeenCalledOnce()
    expect(onRegenerated).toHaveBeenCalledWith({ reason: 'schema-changed', vars: generated })
    render.unmount()
  })

  it('reuses automatically generated vars after evaluation fails under the same schema', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25)
    const onRegenerated = vi.fn()
    const render = renderHook(
      ({ source }) =>
        useCadWorkspace(source, vi.fn(), {
          candidateVars: { fixed: 4, width: 2 },
          onCandidateVarsRegenerated: onRegenerated,
        }),
      { initialProps: { source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    currentVarsSchema = { ...varsSchema, openness: { min: 0, max: 1 } }
    vi.mocked(evaluateDocument).mockRejectedValueOnce(new Error('geometry failed'))
    render.rerender({ source: updateExperimentSourceFile(document, 'experiment.tsx', 'failing geometry') })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Error'))
    const generated = vi.mocked(evaluateDocument).mock.calls[1][0].vars

    render.rerender({ source: updateExperimentSourceFile(document, 'experiment.tsx', 'fixed geometry') })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(vi.mocked(evaluateDocument).mock.calls[2][0].vars).toBe(generated)
    expect(onRegenerated).toHaveBeenCalledOnce()
    expect(random).toHaveBeenCalledTimes(2)
    render.unmount()
  })

  it('clears the generated Candidate cache and schema history when resetKey changes', async () => {
    const random = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75)
      .mockReturnValueOnce(0.75)
    const onRegenerated = vi.fn()
    const render = renderHook(
      ({ resetKey, source }) =>
        useCadWorkspace(source, vi.fn(), {
          candidateVars: { fixed: 4, width: 2 },
          onCandidateVarsRegenerated: onRegenerated,
          resetKey,
        }),
      { initialProps: { resetKey: 1, source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    currentVarsSchema = { ...varsSchema, openness: { min: 0, max: 1 } }
    const edited = updateExperimentSourceFile(document, 'experiment.tsx', 'failing geometry')
    vi.mocked(evaluateDocument).mockRejectedValueOnce(new Error('geometry failed'))
    render.rerender({ resetKey: 1, source: edited })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Error'))
    const beforeReset = vi.mocked(evaluateDocument).mock.calls[1][0].vars

    render.rerender({ resetKey: 2, source: edited })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    const afterReset = vi.mocked(evaluateDocument).mock.calls[2][0].vars

    expect(beforeReset).toEqual({ fixed: 4, width: 3.25, openness: 0.25 })
    expect(afterReset).toEqual({ fixed: 4, width: 7.75, openness: 0.75 })
    expect(afterReset).not.toBe(beforeReset)
    expect(onRegenerated.mock.calls.map(([event]) => event.reason)).toEqual(['schema-changed', 'invalid-candidate'])
    expect(random).toHaveBeenCalledTimes(4)
    render.unmount()
  })

  it('repairs an invalid editable Candidate but never rewrites an invalid persisted Measurement', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const onEditableRegenerated = vi.fn()
    const editable = renderHook(() =>
      useCadWorkspace(document, vi.fn(), {
        candidateVars: {},
        onCandidateVarsRegenerated: onEditableRegenerated,
      }),
    )
    await waitFor(() => expect(editable.result.current.experimentDocument.status).toBe('Ready'))
    expect(vi.mocked(evaluateDocument).mock.calls[0][0].vars).toEqual({ fixed: 4, width: 5.5 })
    expect(onEditableRegenerated).toHaveBeenCalledWith({
      reason: 'invalid-candidate',
      vars: { fixed: 4, width: 5.5 },
    })
    editable.unmount()

    vi.clearAllMocks()
    vi.mocked(fetchCatalogRuntimeSlice).mockResolvedValue(catalog)
    vi.mocked(inspectDocument).mockImplementation(async () => ({ sourceHash, varsSchema: currentVarsSchema }))
    const onPersistedRegenerated = vi.fn()
    const persisted = renderHook(() =>
      useCadWorkspace(document, undefined, {
        candidateVars: {},
        candidateProvenance: 'persisted-measurement',
        onCandidateVarsRegenerated: onPersistedRegenerated,
      }),
    )
    await waitFor(() => expect(persisted.result.current.experimentDocument.status).toBe('Error'))

    expect(persisted.result.current.experimentDocument.error?.title).toBe('Measurement Vars Error')
    expect(persisted.result.current.experimentDocument.error?.message).toContain(
      'vars.fixed is required by varsSchema but is missing from the current Candidate',
    )
    expect(evaluateDocument).not.toHaveBeenCalled()
    expect(onPersistedRegenerated).not.toHaveBeenCalled()
    persisted.unmount()
  })

  it('waits for pending persisted Measurement vars without evaluating, generating, or reporting an error', async () => {
    const random = vi.spyOn(Math, 'random')
    const onRegenerated = vi.fn()
    const render = renderHook(
      ({ candidateVars, pending }: { candidateVars: { fixed: number; width: number } | undefined; pending: boolean }) =>
        useCadWorkspace(document, undefined, {
          candidateVars,
          candidateVarsPending: pending,
          candidateProvenance: 'persisted-measurement',
          onCandidateVarsRegenerated: onRegenerated,
        }),
      {
        initialProps: {
          candidateVars: undefined as { fixed: number; width: number } | undefined,
          pending: true,
        },
      },
    )

    await waitFor(() => expect(render.result.current.experimentDocument.varsSchema).toEqual(varsSchema))
    expect(render.result.current.experimentDocument.status).toBe('Checking')
    expect(render.result.current.experimentDocument.error).toBeNull()
    expect(evaluateDocument).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()
    expect(onRegenerated).not.toHaveBeenCalled()

    render.rerender({ candidateVars: { fixed: 4, width: 2 }, pending: false })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(vi.mocked(evaluateDocument).mock.calls[0][0].vars).toEqual({ fixed: 4, width: 2 })
    expect(random).not.toHaveBeenCalled()
    expect(onRegenerated).not.toHaveBeenCalled()
    render.unmount()
  })

  it('keeps an explicit generation request queued while persisted Measurement vars are pending', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const render = renderHook(
      ({ candidateVars, pending }: { candidateVars: { fixed: number; width: number } | undefined; pending: boolean }) =>
        useCadWorkspace(document, undefined, {
          candidateVars,
          candidateVarsPending: pending,
          candidateProvenance: 'persisted-measurement',
        }),
      {
        initialProps: {
          candidateVars: undefined as { fixed: number; width: number } | undefined,
          pending: true,
        },
      },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.varsSchema).toEqual(varsSchema))

    act(() => render.result.current.experimentDocument.generateCandidate())
    await waitFor(() => expect(inspectDocument).toHaveBeenCalledOnce())
    expect(evaluateDocument).not.toHaveBeenCalled()
    expect(random).not.toHaveBeenCalled()

    render.rerender({ candidateVars: { fixed: 4, width: 2 }, pending: false })
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(vi.mocked(evaluateDocument).mock.calls[0][0].vars).toEqual({ fixed: 4, width: 5.5 })
    expect(random).toHaveBeenCalledOnce()
    render.unmount()
  })

  it('keeps the last successful Scene when a same-session edit fails', async () => {
    const edited = updateExperimentSourceFile(document, 'experiment.tsx', 'broken source')
    const render = renderHook(
      ({ source }) => useCadWorkspace(source, vi.fn(), { candidateVars: { fixed: 4, width: 2 }, resetKey: 1 }),
      { initialProps: { source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    const lastScene = render.result.current.experimentDocument.scene
    expect(lastScene).not.toBeNull()

    vi.mocked(inspectDocument).mockRejectedValueOnce(new Error('syntax failed'))
    render.rerender({ source: edited })

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Error'))
    expect(render.result.current.experimentDocument.scene).toBe(lastScene)
    expect(render.result.current.experimentDocument.error?.message).toBe('syntax failed')
    render.unmount()
  })

  it('keeps unresolved Geometry viewable while blocking Measurement and simulation readiness', async () => {
    vi.mocked(evaluateDocument).mockImplementationOnce(async ({ vars }) => ({
      kind: 'experiment',
      scene: unresolvedScene,
      taskScenes: { electric: serializedScene },
      simulationProgram: {
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        tasks: { electric: { kernel: { name: 'test', version: '1' }, config: emptyTaskConfig } },
        recordedData: {},
      },
      sourceHash,
      variables: vars,
      varsSchema,
    }))
    const render = renderHook(() => useCadWorkspace(document, vi.fn(), { candidateVars: { fixed: 4, width: 2 } }))

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(render.result.current.experimentDocument.scene?.parts[0].materialRole).toBe('wheel')
    expect(render.result.current.experimentDocument.measurement).toBeNull()
    expect(render.result.current.experimentDocument.materialParameters).toBeNull()
    expect(render.result.current.experimentDocument.materialWarnings).toContain(
      'Measurement requires resolved Material roles: Experiment: wheel.',
    )
    expect(render.result.current.simulation.canRun).toBe(false)
    render.unmount()
  })

  it('keeps Draft Task geometry viewable while withholding Measurement and CAE execution artifacts', async () => {
    vi.mocked(fetchCatalogRuntimeSlice).mockResolvedValueOnce(draftCatalog)
    registerSourceCatalogRuntimeSlice(sourceHash, draftCatalog)
    vi.mocked(evaluateDocument).mockImplementationOnce(async ({ vars }) => ({
      kind: 'experiment',
      scene: serializedScene,
      taskScenes: { electric: serializedScene },
      simulationProgram: {
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        tasks: {
          electric: {
            kernel: { name: 'replace-with-solver', version: '1.0.0' },
            config: {},
          },
        },
        recordedData: {},
      },
      sourceHash,
      variables: vars,
      varsSchema,
    }))
    const render = renderHook(() => useCadWorkspace(document, vi.fn(), { candidateVars: { fixed: 4, width: 2 } }))

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(render.result.current.experimentDocument.scene).not.toBeNull()
    expect(render.result.current.experimentDocument.draftTaskNames).toEqual(['electric'])
    expect(render.result.current.experimentDocument.measurement).toBeNull()
    expect(render.result.current.experimentDocument.simulationProgram).toBeNull()
    expect(render.result.current.experimentDocument.materialParameters).toBeNull()
    expect(render.result.current.experimentDocument.successfulRevision).toBe(
      render.result.current.experimentDocument.revision,
    )
    expect(render.result.current.simulation.canRun).toBe(false)
    render.unmount()
  })

  it('blocks the whole Experiment when real and Draft Tasks are mixed', async () => {
    vi.mocked(evaluateDocument).mockImplementationOnce(async ({ vars }) => ({
      kind: 'experiment',
      scene: serializedScene,
      taskScenes: { electric: serializedScene, draft: serializedScene },
      simulationProgram: {
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        tasks: {
          electric: { kernel: { name: 'test', version: '1' }, config: emptyTaskConfig },
          draft: { kernel: { name: 'replace-with-solver', version: '1.0.0' }, config: {} },
        },
        recordedData: {},
      },
      sourceHash,
      variables: vars,
      varsSchema,
    }))
    vi.mocked(resolveDocumentMaterials).mockResolvedValueOnce({
      materialParameters: emptyMaterials,
      warnings: [],
      taskMaterialParameters: { electric: emptyMaterials, draft: emptyMaterials },
      taskMaterialWarnings: { electric: [], draft: [] },
    })
    const render = renderHook(() => useCadWorkspace(document, vi.fn(), { candidateVars: { fixed: 4, width: 2 } }))

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    expect(render.result.current.experimentDocument.draftTaskNames).toEqual(['draft'])
    expect(render.result.current.experimentDocument.measurement).toBeNull()
    expect(render.result.current.experimentDocument.simulationProgram).toBeNull()
    expect(render.result.current.simulation.canRun).toBe(false)
    render.unmount()
  })
})
