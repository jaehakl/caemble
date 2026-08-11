// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compileCadDocument,
  createCadSourceDocument,
  createExperimentSourceBundle,
  evaluateInIsolatedRunner,
  type CompiledCadDocument,
  type Vars,
} from '@/lib/cad'
import { useCadWorkspace } from './useCadWorkspace'

const compilerVersion = 'test-compiler' as CompiledCadDocument['compilerVersion']

vi.mock('@/lib/cad', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/cad')>()
  return { ...actual, compileCadDocument: vi.fn(), evaluateInIsolatedRunner: vi.fn() }
})

describe('useCadWorkspace v4 bundle editing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(compileCadDocument).mockReset()
    vi.mocked(evaluateInIsolatedRunner).mockReset()
  })

  afterEach(() => vi.useRealTimers())

  it('updates Program files and adds/removes Task files through whole-document changes', () => {
    const onChange = vi.fn()
    const document = createCadSourceDocument(
      'experiment',
      createExperimentSourceBundle({
        'experiment.tsx': 'experiment',
        'simulate.py': 'simulate',
        'tasks/electric.tsx': 'electric',
      }),
      9,
    )
    const render = renderHook(() => useCadWorkspace(null, document, undefined, onChange))

    act(() => render.result.current.experimentDocument.handleExperimentFileChange('simulate.py', 'changed'))
    expect(onChange.mock.calls[0][0].sourceBundle.files['simulate.py']).toBe('changed')

    act(() => render.result.current.experimentDocument.handleAddExperimentTask('thermal', 'thermal'))
    expect(onChange.mock.calls[1][0].sourceBundle.files['tasks/thermal.tsx']).toBe('thermal')

    const withTwoTasks = onChange.mock.calls[1][0]
    render.unmount()
    const removeChange = vi.fn()
    const second = renderHook(() => useCadWorkspace(null, withTwoTasks, undefined, removeChange))
    act(() => second.result.current.experimentDocument.handleRemoveExperimentTask('electric'))
    expect(second.result.current.experimentDocument.documentType).toBe('experiment')
    expect(removeChange.mock.calls[0][0].sourceBundle.files).not.toHaveProperty('tasks/electric.tsx')
    second.unmount()
  })

  it('keeps Experiment Task scene hashes stable across render status transitions', () => {
    const render = renderHook(() => useCadWorkspace(null, null, undefined, undefined))
    const initialHashes = render.result.current.experimentDocument.taskSceneHashes

    expect(render.result.current.experimentDocument.status).toBe('Ready')
    act(() => render.result.current.experimentDocument.handleRenderStart())
    expect(render.result.current.experimentDocument.status).toBe('Rendering')
    expect(render.result.current.experimentDocument.taskSceneHashes).toBe(initialHashes)

    act(() => render.result.current.experimentDocument.handleRenderEnd())
    expect(render.result.current.experimentDocument.status).toBe('Ready')
    expect(render.result.current.experimentDocument.taskSceneHashes).toBe(initialHashes)
    render.unmount()
  })

  it('drops selected vars and reuses the compiled Structure source for a seed reroll', async () => {
    const sourceHash = 'a'.repeat(64)
    vi.mocked(compileCadDocument).mockResolvedValue({
      apiVersion: 4,
      compilerVersion,
      sourceHash,
      sources: {
        'structure.tsx': {
          apiVersion: 4,
          compilerVersion,
          entryFile: 'structure.tsx',
          code: 'module.exports.default = {}',
          sourceHash,
        },
      },
    })
    vi.mocked(evaluateInIsolatedRunner).mockReturnValue(vi.fn())
    const document = createCadSourceDocument('structure', 'structure', 7)
    const render = renderHook(
      ({ active, externalVars }: { active: typeof document; externalVars: Vars | undefined }) =>
        useCadWorkspace(active, null, () => undefined, undefined, externalVars, undefined, undefined, 'fast-reroll'),
      { initialProps: { active: document, externalVars: { radius: 2 } as Vars | undefined } },
    )

    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(compileCadDocument).toHaveBeenCalledOnce()
    expect(vi.mocked(evaluateInIsolatedRunner).mock.calls[0][0]).toMatchObject({
      document: { realizationSeed: 7 },
      revision: 1,
      vars: { radius: 2 },
    })

    render.rerender({ active: { ...document, realizationSeed: 8 }, externalVars: undefined })
    await act(async () => vi.advanceTimersByTimeAsync(75))
    expect(compileCadDocument).toHaveBeenCalledOnce()
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(2)
    const rerollRequest = vi.mocked(evaluateInIsolatedRunner).mock.calls[1][0]
    expect(rerollRequest).toMatchObject({
      document: { realizationSeed: 8 },
      revision: 2,
    })
    expect(rerollRequest).not.toHaveProperty('vars')
    expect(rerollRequest.compiledDocument.sourceHash).toBe(sourceHash)
    render.unmount()
  })
})
