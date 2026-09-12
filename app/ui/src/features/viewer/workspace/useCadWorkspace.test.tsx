import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluatedExperimentSnapshot } from '@/lib/cad/execution'
import type { ExperimentSourceDocument } from '@/lib/cad/source'
import { useCadWorkspace } from './useCadWorkspace'
import { readCatalogExamples } from '../../../../scripts/catalog-example-support'
import { resolveSceneMaterials } from '@/lib/material/document'
import { buildMeasurement } from '@/lib/cad/execution/measurement'
import type { CadScene } from '@/lib/cad/evaluation/types'

const mocks = vi.hoisted(() => ({
  applyMaterialSnapshot: vi.fn(),
  buildMeasurement: vi.fn(),
  deserializeCadScene: vi.fn(),
  evaluateDocument: vi.fn(),
  fetchCatalogRuntimeSlice: vi.fn(),
  inspectDocument: vi.fn(),
  resolveDocumentMaterials: vi.fn(),
}))

vi.mock('@/features/runtime-console/types', () => ({ emitRuntimeActivity: vi.fn() }))

vi.mock('@/lib/cad/compiler/monacoCompiler', () => {
  class CadCompilationError extends Error {}
  return { CadCompilationError }
})

vi.mock('@/lib/cad/execution', () => {
  class CadDocumentEvaluationError extends Error {}
  return {
    applyMaterialSnapshot: mocks.applyMaterialSnapshot,
    buildMeasurement: mocks.buildMeasurement,
    CadDocumentEvaluationError,
    deserializeCadScene: mocks.deserializeCadScene,
    evaluateDocument: mocks.evaluateDocument,
    inspectDocument: mocks.inspectDocument,
  }
})

vi.mock('@/lib/cad/model', () => ({
  generateRandomVars: vi.fn(() => Object.freeze({})),
  normalizeVars: vi.fn((_schema, vars) => vars),
  normalizeVarsSchema: vi.fn((schema) => schema),
  varsSchemaFingerprint: vi.fn(() => 'schema-v1'),
}))

vi.mock('@/lib/cad/source', () => {
  const keepDocument = (document: unknown) => document
  return {
    EXPERIMENT_SIMULATION_PATH: 'simulate.py',
    addExperimentSourceFile: keepDocument,
    addExperimentTask: keepDocument,
    removeExperimentSourceFile: keepDocument,
    removeExperimentTask: keepDocument,
    updateCadSource: keepDocument,
    updateExperimentSourceFile: keepDocument,
  }
})

vi.mock('@/lib/catalog/runtime', () => ({ sourceCatalogRuntimeSlice: vi.fn(() => Object.freeze({})) }))
vi.mock('@/lib/catalog/solverTasks', () => ({ catalogDraftTaskNames: vi.fn(() => []) }))
vi.mock('../persistence/resolveMaterials', () => ({ resolveDocumentMaterials: mocks.resolveDocumentMaterials }))
vi.mock('./catalogRuntime', () => ({ fetchCatalogRuntimeSlice: mocks.fetchCatalogRuntimeSlice }))

const firstExperiment: ExperimentSourceDocument = Object.freeze({
  kind: 'experiment',
  sourceBundle: Object.freeze({ files: Object.freeze({ 'experiment.tsx': 'export default 1' }) }),
})
const secondExperiment: ExperimentSourceDocument = Object.freeze({
  kind: 'experiment',
  sourceBundle: Object.freeze({ files: Object.freeze({ 'experiment.tsx': 'export default 2' }) }),
})
const firstCandidateVars: Readonly<Record<string, number>> = Object.freeze({ x: 1 })
const secondCandidateVars: Readonly<Record<string, number>> = Object.freeze({ x: 2 })

function evaluatedSnapshot(sourceHash: string): EvaluatedExperimentSnapshot {
  return {
    kind: 'experiment',
    sourceHash,
    variables: Object.freeze({}),
    varsSchema: Object.freeze({}),
    scene: Object.freeze({}),
    taskScenes: Object.freeze({}),
    renderScene: Object.freeze({ sceneHash: `${sourceHash}-scene` }),
    taskRenderScenes: Object.freeze({}),
    simulationProgram: Object.freeze({ tasks: Object.freeze({ solve: Object.freeze({}) }) }),
  } as unknown as EvaluatedExperimentSnapshot
}

beforeEach(() => {
  mocks.applyMaterialSnapshot.mockReset().mockImplementation((scene) => scene)
  mocks.buildMeasurement.mockReset().mockImplementation((snapshot, resolution) => ({
    experiment: snapshot,
    ...resolution,
    varsHash: 'vars',
    modelDefinitions: [],
    materialSelections: {},
  }))
  mocks.deserializeCadScene.mockReset().mockImplementation((scene) => scene)
  mocks.evaluateDocument.mockReset().mockResolvedValue(evaluatedSnapshot('default'))
  mocks.fetchCatalogRuntimeSlice.mockReset().mockResolvedValue({ catalogRevision: 'test' })
  mocks.inspectDocument.mockReset().mockResolvedValue({ varsSchema: Object.freeze({}) })
  mocks.resolveDocumentMaterials.mockReset().mockResolvedValue({
    materialSnapshot: Object.freeze({}),
    taskMaterialSnapshots: Object.freeze({}),
    warnings: Object.freeze([]),
    taskMaterialWarnings: Object.freeze({}),
  })
})

describe('useCadWorkspace lifecycle boundary', () => {
  it.each([false, true])(
    'validates an Output Box through Solver Material roles (physical input: %s)',
    async (physicalInput) => {
      const { catalog } = readCatalogExamples('../catalog/caemble_catalog/catalog.sqlite3')
      const solver = catalog.solvers.find((item) => item.name === 'ray-tracing')!
      const probe = { id: 'output-grid', materialRole: 'body', geometry: null, surfaces: [] }
      const scene: CadScene = {
        lengthUnit: 'm',
        parts: [],
        geometryGroups: [],
        surfaceGroups: [],
        tree: { key: 'root', label: 'root', children: [] },
      }
      const experimentScene = scene
      const taskScene = {
        ...scene,
        parts: [probe],
        geometryGroups: [
          {
            id: 'outputGrid',
            name: 'outputGrid',
            kind: 'geometry' as const,
            geometryIds: [probe.id],
            memberIds: [probe.id],
            missingMemberIds: [],
          },
        ],
      }
      const snapshot = {
        ...evaluatedSnapshot('output-box'),
        scene: { roots: experimentScene.parts },
        taskScenes: { solve: { roots: [probe] } },
        renderScene: experimentScene,
        taskRenderScenes: { solve: taskScene },
        simulationProgram: {
          tasks: {
            solve: {
              kernel: { name: solver.name, version: solver.version },
              config: {
                initializations: physicalInput
                  ? [{ methodId: 'ray.domain', target: ['task.geometry.outputGrid'] }]
                  : [],
              },
            },
          },
        },
      } as unknown as EvaluatedExperimentSnapshot
      mocks.fetchCatalogRuntimeSlice.mockResolvedValue(catalog)
      mocks.evaluateDocument.mockResolvedValue(snapshot)
      mocks.buildMeasurement.mockImplementation(buildMeasurement)
      mocks.resolveDocumentMaterials.mockImplementation((evaluated, stored, runtimeCatalog) =>
        resolveSceneMaterials(
          { ...evaluated, scene: experimentScene, taskScenes: { solve: taskScene } },
          stored,
          runtimeCatalog,
        ),
      )

      const { result } = renderHook(() =>
        useCadWorkspace(firstExperiment, undefined, { candidateVars: firstCandidateVars }),
      )
      await waitFor(() => expect(result.current.experimentDocument.status).toBe(physicalInput ? 'Error' : 'Ready'))
      if (physicalInput) {
        expect(result.current.experimentDocument.error?.message).toMatch(/requires a Material/u)
        expect(mocks.buildMeasurement).not.toHaveBeenCalled()
        expect(result.current.experimentDocument.measurement).toBeNull()
      } else {
        expect(result.current.experimentDocument.measurement?.experiment).toMatchObject({ sourceHash: 'output-box' })
        expect(result.current.experimentDocument.materialSnapshot?.tasks.solve.materials).toEqual({})
        expect(result.current.experimentDocument.materialWarnings).toEqual([])
      }
    },
  )

  it('reuses the prepared document when only Candidate vars change', async () => {
    const { result, rerender } = renderHook(
      ({ candidateVars }) => useCadWorkspace(firstExperiment, undefined, { candidateVars }),
      { initialProps: { candidateVars: firstCandidateVars } },
    )

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(1)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(1)
    expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1)

    rerender({ candidateVars: secondCandidateVars })

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.experimentDocument.status).toBe('Ready'))
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(1)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(1)
  })

  it('does not let an aborted source revision overwrite the current result', async () => {
    let resolveFirstEvaluation: (snapshot: EvaluatedExperimentSnapshot) => void = () => undefined
    const firstEvaluation = new Promise<EvaluatedExperimentSnapshot>((resolve) => {
      resolveFirstEvaluation = resolve
    })
    mocks.evaluateDocument
      .mockImplementationOnce(() => firstEvaluation)
      .mockResolvedValueOnce(evaluatedSnapshot('current'))
    const candidateVars = firstCandidateVars
    const { result, rerender } = renderHook(
      ({ experiment }) => useCadWorkspace(experiment, undefined, { candidateVars }),
      { initialProps: { experiment: firstExperiment } },
    )

    await waitFor(() => expect(mocks.evaluateDocument).toHaveBeenCalledTimes(1))
    rerender({ experiment: secondExperiment })
    await waitFor(() => expect(result.current.experimentDocument.evaluatedSnapshot?.sourceHash).toBe('current'))

    await act(async () => {
      resolveFirstEvaluation(evaluatedSnapshot('superseded'))
      await firstEvaluation
    })

    expect(result.current.experimentDocument.evaluatedSnapshot?.sourceHash).toBe('current')
    expect(mocks.fetchCatalogRuntimeSlice).toHaveBeenCalledTimes(2)
    expect(mocks.inspectDocument).toHaveBeenCalledTimes(2)
  })
})
