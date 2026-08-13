import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'

describe('Geometry Monaco type environment', () => {
  it('keeps named coordinate modules installed and restores the latest authoring graph after compilation', async () => {
    vi.resetModules()
    const disposed: string[] = []
    const addExtraLib = vi.fn((_source: string, path: string) => ({ dispose: () => disposed.push(path) }))
    const monaco = { typescript: { typescriptDefaults: { addExtraLib } } } as unknown as typeof Monaco
    vi.doMock('./monacoRuntime', () => ({ loadMonaco: async () => monaco }))
    const { initializeGeometryTypeEnvironment, setGeometryAuthoringGraph, withGeometryTypeEnvironment } =
      await import('./geometryTypeEnvironment')
    initializeGeometryTypeEnvironment(monaco)
    const current = {
      entryImports: [{ exportName: 'Current', alias: 'Current', coordinate: 'current' }],
      modules: [{ coordinate: 'current', source: 'export const Current = () => <box />', imports: [] }],
    }
    setGeometryAuthoringGraph(current)
    await vi.waitFor(() => expect(addExtraLib.mock.calls.some((call) => call[1].includes('current'))).toBe(true))
    await withGeometryTypeEnvironment(
      monaco,
      {
        entryImports: [],
        modules: [{ coordinate: 'temporary', source: 'export const Temporary = () => <box />', imports: [] }],
      },
      async () => undefined,
    )
    const latestCoordinateDeclaration = addExtraLib.mock.calls
      .filter((call) => call[1] === 'file:///geometry-coordinates.d.ts')
      .slice(-1)[0]?.[0]
    expect(latestCoordinateDeclaration).toContain('"current"')
    expect(latestCoordinateDeclaration).not.toContain('"temporary"')
    expect(disposed).toContain('file:///geometry-coordinates.d.ts')
  })
})
