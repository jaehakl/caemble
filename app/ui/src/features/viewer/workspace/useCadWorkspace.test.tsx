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
} from '@/lib/cad'
import { resolveDocumentMaterials } from '../persistence/resolveMaterials'
import { useCadWorkspace } from './useCadWorkspace'

vi.mock('@/lib/cad', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cad')>()
  return { ...actual, evaluateDocument: vi.fn(), inspectDocument: vi.fn() }
})
vi.mock('../persistence/resolveMaterials', () => ({ resolveDocumentMaterials: vi.fn() }))

const emptyMaterials = { schemaVersion: 1, materials: {} } as const
const varsSchema = { fixed: { min: 4, max: 4 }, width: { min: 1, max: 10 } } as const
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
    vi.mocked(inspectDocument).mockResolvedValue({ sourceHash: 'a'.repeat(64), varsSchema })
    vi.mocked(evaluateDocument).mockImplementation(async ({ vars }) => ({
      kind: 'experiment',
      scene: serializedScene,
      taskScenes: { electric: serializedScene },
      simulationProgram: {
        formatVersion: 5,
        simulationApiVersion: 3,
        pythonSource: 'async def simulate(*, sim, tasks, vars):\n    return None\n',
        tasks: { electric: { kernel: { name: 'test', version: '1' }, config: {} } },
        recordedData: {},
      },
      sourceHash: 'a'.repeat(64),
      variables: vars,
      varsSchema,
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
    const render = renderHook(() => useCadWorkspace(document, onChange, { fixed: 4, width: 2 }))

    act(() => render.result.current.experimentDocument.handleExperimentFileChange('simulate.py', 'changed'))
    expect(onChange.mock.calls[0][0].sourceBundle.files['simulate.py']).toBe('changed')

    act(() => render.result.current.experimentDocument.handleAddExperimentTask('thermal', 'thermal'))
    expect(onChange.mock.calls[1][0].sourceBundle.files['tasks/thermal.tsx']).toBe('thermal')

    const withTwoTasks = onChange.mock.calls[1][0]
    render.unmount()
    const removeChange = vi.fn()
    const second = renderHook(() => useCadWorkspace(withTwoTasks, removeChange, { fixed: 4, width: 2 }))
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

  it('generates a new in-range candidate without changing source and keeps min == max fixed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const onChange = vi.fn()
    const render = renderHook(() =>
      useCadWorkspace(
        document,
        onChange,
        { fixed: 4, width: 2 },
        { schemaVersion: 2, experiment: emptyMaterials, tasks: { electric: emptyMaterials } },
      ),
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))

    act(() => render.result.current.experimentDocument.generateCandidate())
    await waitFor(() => expect(evaluateDocument).toHaveBeenCalledTimes(2))
    expect(vi.mocked(evaluateDocument).mock.calls[1][0].document).toBe(document)
    expect(vi.mocked(evaluateDocument).mock.calls[1][0].vars).toEqual({ fixed: 4, width: 7.75 })
    expect(resolveDocumentMaterials).toHaveBeenLastCalledWith(expect.anything(), null, false)
    expect(onChange).not.toHaveBeenCalled()
    render.unmount()
  })

  it('keeps the last successful Scene when a same-session edit fails', async () => {
    const edited = updateExperimentSourceFile(document, 'experiment.tsx', 'broken source')
    const render = renderHook(
      ({ source }) => useCadWorkspace(source, vi.fn(), { fixed: 4, width: 2 }, null, true, undefined, 1),
      { initialProps: { source: document } },
    )
    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Ready'))
    const lastScene = render.result.current.experimentDocument.scene
    expect(lastScene).not.toBeNull()

    vi.mocked(inspectDocument).mockRejectedValueOnce(new Error('syntax failed'))
    render.rerender({ source: edited })

    await waitFor(() => expect(render.result.current.experimentDocument.status).toBe('Error'))
    expect(render.result.current.experimentDocument.scene).toBe(lastScene)
    expect(render.result.current.experimentDocument.previewStale).toBe(true)
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
        tasks: { electric: { kernel: { name: 'test', version: '1' }, config: {} } },
        recordedData: {},
      },
      sourceHash: 'a'.repeat(64),
      variables: vars,
      varsSchema,
    }))
    const render = renderHook(() => useCadWorkspace(document, vi.fn(), { fixed: 4, width: 2 }))

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
})
