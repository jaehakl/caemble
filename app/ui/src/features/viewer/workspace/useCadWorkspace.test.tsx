// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compileCadDocument,
  createCadSourceDocument,
  createExperimentSourceBundle,
  evaluateInIsolatedRunner,
  type CompiledCadDocument,
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

  it('compiles once for a Structure source and reuses the compiled document for a seed change', async () => {
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
      ({ active }) =>
        useCadWorkspace(active, null, () => undefined, undefined, undefined, undefined, undefined, 'fast-reroll'),
      { initialProps: { active: document } },
    )

    await act(async () => vi.advanceTimersByTimeAsync(500))
    expect(compileCadDocument).toHaveBeenCalledOnce()
    render.rerender({ active: { ...document, realizationSeed: 8 } })
    await act(async () => vi.advanceTimersByTimeAsync(75))
    expect(compileCadDocument).toHaveBeenCalledOnce()
    expect(evaluateInIsolatedRunner).toHaveBeenCalledTimes(2)
    expect(vi.mocked(evaluateInIsolatedRunner).mock.calls[1][0].compiledDocument.sourceHash).toBe(sourceHash)
    render.unmount()
  })
})
