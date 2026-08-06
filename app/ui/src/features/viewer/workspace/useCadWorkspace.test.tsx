// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compileCadDocument,
  createCadSourceDocument,
  evaluateInIsolatedRunner,
  preflightSimulationInIsolatedRunner,
  runSimulationInIsolatedRunner,
  serializeCadScene,
  updateCadSource,
  type CadEvaluationResponse,
  type CompiledCadSource,
  type EvaluatedDocumentSnapshot,
} from '@/lib/cad'
import type { SimulationResult } from '@/lib/simulation'
import { useCadWorkspace } from './useCadWorkspace'

const compilerVersion = 'test-compiler' as CompiledCadSource['compilerVersion']

vi.mock('@/lib/cad', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cad')>()
  return {
    ...actual,
    compileCadDocument: vi.fn(),
    evaluateInIsolatedRunner: vi.fn(),
    preflightSimulationInIsolatedRunner: vi.fn(),
    runSimulationInIsolatedRunner: vi.fn(),
  }
})

describe('useCadWorkspace compilation cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(compileCadDocument).mockReset()
    vi.mocked(evaluateInIsolatedRunner).mockReset()
    vi.mocked(preflightSimulationInIsolatedRunner).mockReset()
    vi.mocked(runSimulationInIsolatedRunner).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('compiles once for a source revision and reuses it for vars and seed rerolls', async () => {
    const callbacks: Array<Parameters<typeof evaluateInIsolatedRunner>[1]> = []
    const cancels: ReturnType<typeof vi.fn>[] = []
    vi.mocked(compileCadDocument).mockImplementation(
      async (document) =>
        ({
          apiVersion: 3,
          compilerVersion,
          entryFile: `${document.kind}.tsx`,
          code: 'module.exports.default = {}',
          sourceHash: (document.source.includes('changed') ? 'b' : 'a').repeat(64),
        }) as CompiledCadSource,
    )
    vi.mocked(evaluateInIsolatedRunner).mockImplementation((_request, handlers) => {
      const cancel = vi.fn()
      callbacks.push(handlers)
      cancels.push(cancel)
      return cancel
    })

    const document = createCadSourceDocument(
      'structure',
      `export default structure({ lengthUnit: 'mm', varsSchema: {}, geometry: () => null })`,
      7,
    )
    const handleStructureChange = vi.fn()
    const initialProps: {
      activeDocument: typeof document
      vars?: { width: number }
    } = { activeDocument: document }
    const render = renderHook(
      ({ activeDocument, vars }: { activeDocument: typeof document; vars?: { width: number } }) =>
        useCadWorkspace(
          activeDocument,
          null,
          handleStructureChange,
          undefined,
          vars,
          undefined,
          undefined,
          'fast-reroll',
        ),
      { initialProps },
    )

    expect(render.result.current.simulation.run()).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(compileCadDocument).toHaveBeenCalledTimes(1)
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(1)

    const finishWithError = (index: number) => {
      const request = vi.mocked(evaluateInIsolatedRunner).mock.calls[index][0]
      const response: CadEvaluationResponse = {
        type: 'evaluation-error',
        requestId: request.requestId,
        revision: request.revision,
        documentType: 'structure',
        errorType: 'model',
        message: 'test response',
      }
      act(() => callbacks[index].onResponse(response))
      return request
    }
    finishWithError(0)

    render.rerender({ activeDocument: document, vars: { width: 2 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75)
    })
    expect(compileCadDocument).toHaveBeenCalledTimes(1)
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(2)
    expect(vi.mocked(evaluateInIsolatedRunner).mock.calls[1][0]).toMatchObject({
      vars: { width: 2 },
    })
    finishWithError(1)

    const rerolledDocument = Object.freeze({ ...document, realizationSeed: 11 })
    render.rerender({ activeDocument: rerolledDocument, vars: undefined })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75)
    })
    expect(compileCadDocument).toHaveBeenCalledTimes(1)
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(3)
    expect(vi.mocked(evaluateInIsolatedRunner).mock.calls[2][0]).toMatchObject({
      document: { realizationSeed: 11 },
    })
    finishWithError(2)

    const changedSource = updateCadSource(document, `${document.source}\n// changed`)
    render.rerender({ activeDocument: changedSource, vars: undefined })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(compileCadDocument).toHaveBeenCalledTimes(2)
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(4)

    render.unmount()
    expect(cancels[cancels.length - 1]).toHaveBeenCalledOnce()
  })

  it('ignores a late response after a newer revision cancels the evaluation', async () => {
    const callbacks: Array<Parameters<typeof evaluateInIsolatedRunner>[1]> = []
    const cancels: ReturnType<typeof vi.fn>[] = []
    vi.mocked(compileCadDocument).mockResolvedValue({
      apiVersion: 3,
      compilerVersion,
      entryFile: 'structure.tsx',
      code: 'module.exports.default = {}',
      sourceHash: 'a'.repeat(64),
    })
    vi.mocked(evaluateInIsolatedRunner).mockImplementation((_request, handlers) => {
      const cancel = vi.fn()
      callbacks.push(handlers)
      cancels.push(cancel)
      return cancel
    })

    const document = createCadSourceDocument('structure', 'first source', 1)
    const render = renderHook(
      ({ activeDocument }) => useCadWorkspace(activeDocument, null, () => undefined, undefined),
      { initialProps: { activeDocument: document } },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    const firstRequest = vi.mocked(evaluateInIsolatedRunner).mock.calls[0][0]

    render.rerender({ activeDocument: updateCadSource(document, 'second source') })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(cancels[0]).toHaveBeenCalledOnce()
    await act(async () => {
      callbacks[0].onResponse({
        type: 'evaluation-error',
        requestId: firstRequest.requestId,
        revision: firstRequest.revision,
        documentType: 'structure',
        errorType: 'runtime',
        message: 'late failure',
      })
    })

    expect(render.result.current.structureDocument.error).toBeNull()
    expect(render.result.current.structureDocument.status).toBe('Evaluating')
    render.unmount()
  })

  it('runs from cached compiled code and ignores a late result after source invalidation', async () => {
    const structureHash = 'a'.repeat(64)
    const experimentHash = 'b'.repeat(64)
    const program = Object.freeze({
      formatVersion: 1 as const,
      programHash: experimentHash,
      tasks: Object.freeze({
        electric: Object.freeze({
          kernel: Object.freeze({ name: 'dc-current-density', version: '0.0.0' }),
          configHash: 'dc-config',
        }),
      }),
      recordedData: Object.freeze({}),
    })
    const scene = serializeCadScene({
      lengthUnit: 'mm',
      parts: [],
      tree: { key: 'root', label: 'root', children: [] },
      geometryGroups: [],
      surfaceGroups: [],
    })
    const evaluationCallbacks: Array<Parameters<typeof evaluateInIsolatedRunner>[1]> = []
    let preflightCallbacks: Parameters<typeof preflightSimulationInIsolatedRunner>[1] | undefined
    let runCallbacks: Parameters<typeof runSimulationInIsolatedRunner>[1] | undefined
    const runCancel = vi.fn()
    vi.mocked(compileCadDocument).mockImplementation(async (document) => ({
      apiVersion: 3,
      compilerVersion,
      entryFile: `${document.kind}.tsx`,
      code: 'module.exports.default = {}',
      sourceHash: document.kind === 'structure' ? structureHash : experimentHash,
    }))
    vi.mocked(evaluateInIsolatedRunner).mockImplementation((_request, handlers) => {
      evaluationCallbacks.push(handlers)
      return vi.fn()
    })
    vi.mocked(preflightSimulationInIsolatedRunner).mockImplementation((_request, handlers) => {
      preflightCallbacks = handlers
      return vi.fn()
    })
    vi.mocked(runSimulationInIsolatedRunner).mockImplementation((_request, handlers) => {
      runCallbacks = handlers
      return runCancel
    })

    const structure = createCadSourceDocument('structure', 'structure source', 7)
    const experiment = createCadSourceDocument('experiment', 'experiment source', 9)
    const render = renderHook(
      ({ structureDocument, experimentDocument }) =>
        useCadWorkspace(
          structureDocument,
          experimentDocument,
          () => undefined,
          () => undefined,
        ),
      {
        initialProps: {
          structureDocument: structure,
          experimentDocument: experiment,
        },
      },
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(compileCadDocument).toHaveBeenCalledTimes(2)
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(2)

    await act(async () => {
      vi.mocked(evaluateInIsolatedRunner).mock.calls.forEach(([request], index) => {
        const snapshot = {
          kind: request.document.kind,
          sourceHash: request.compiledSource.sourceHash,
          seed: request.document.realizationSeed,
          variables: {},
          varsSchema: {},
          scene,
          ...(request.document.kind === 'experiment' ? { simulationProgram: program } : {}),
        } as EvaluatedDocumentSnapshot
        evaluationCallbacks[index].onStart()
        evaluationCallbacks[index].onResponse({
          type: 'evaluation-success',
          requestId: request.requestId,
          revision: request.revision,
          documentType: request.document.kind,
          snapshot,
        })
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(preflightSimulationInIsolatedRunner).toHaveBeenCalledOnce()
    const preflightRequest = vi.mocked(preflightSimulationInIsolatedRunner).mock.calls[0][0]
    await act(async () => {
      preflightCallbacks?.onResponse({
        type: 'preflight-simulation-result',
        requestId: preflightRequest.requestId,
        structureRevision: preflightRequest.structureRevision,
        experimentRevision: preflightRequest.experimentRevision,
        issues: [],
      })
    })
    expect(render.result.current.simulation.canRun).toBe(true)

    let requestId: string | null = null
    await act(async () => {
      requestId = render.result.current.simulation.run()
    })
    expect(requestId).not.toBeNull()
    expect(compileCadDocument).toHaveBeenCalledTimes(2)
    expect(runSimulationInIsolatedRunner).toHaveBeenCalledOnce()
    const runRequest = vi.mocked(runSimulationInIsolatedRunner).mock.calls[0][0]
    expect(runRequest.compiledSource.sourceHash).toBe(experimentHash)

    const changedExperiment = updateCadSource(experiment, 'changed experiment source')
    await act(async () => {
      render.rerender({
        structureDocument: structure,
        experimentDocument: changedExperiment,
      })
    })
    expect(runCancel).toHaveBeenCalledOnce()
    expect(render.result.current.simulation.process.status).toBe('cancelled')

    const lateResult: SimulationResult = {
      format: 'caemble-run',
      formatVersion: 1,
      runId: requestId!,
      finalStateRevision: 0,
      recordedData: {},
      trace: [],
      provenance: {
        programHash: experimentHash,
        structureSourceHash: structureHash,
        experimentSourceHash: experimentHash,
        structureSeed: 7,
        experimentSeed: 9,
        structureVars: {},
        experimentVars: {},
        kernels: [],
      },
    }
    await act(async () => {
      runCallbacks?.onResponse({
        type: 'run-simulation-success',
        requestId: requestId!,
        structureRevision: runRequest.structureRevision,
        experimentRevision: runRequest.experimentRevision,
        result: lateResult,
      })
    })
    expect(render.result.current.simulation.programResult).toBeNull()
    expect(render.result.current.simulation.process.status).toBe('cancelled')
    render.unmount()
  })
})
