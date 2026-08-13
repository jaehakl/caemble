import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'

describe('Geometry Monaco type environment', () => {
  it('keeps exact root and coordinate declarations installed for authoring', async () => {
    vi.resetModules()
    const disposed: string[] = []
    const addExtraLib = vi.fn((_source: string, path: string) => ({ dispose: () => disposed.push(path) }))
    const monaco = {
      typescript: { typescriptDefaults: { addExtraLib } },
    } as unknown as typeof Monaco
    vi.doMock('./monacoRuntime', () => ({ loadMonaco: async () => monaco }))
    const {
      initializeGeometryTypeEnvironment,
      setGeometryAuthoringGraph,
      setGeometryAuthoringRootsEnabled,
      withGeometryTypeEnvironment,
    } = await import('./geometryTypeEnvironment')
    initializeGeometryTypeEnvironment(monaco)
    setGeometryAuthoringRootsEnabled(true)
    setGeometryAuthoringGraph({
      roots: [{ alias: 'Notched', coordinate: 'caemble:geometry/jlee/common/notched@1.0.0' }],
      modules: [
        {
          coordinate: 'caemble:geometry/jlee/common/notched@1.0.0',
          source: 'const Notched = () => <box size={[1, 1, 1]} />; export default Notched',
        },
      ],
    })

    await vi.waitFor(() => expect(addExtraLib.mock.calls.length).toBeGreaterThanOrEqual(5))
    const roots = addExtraLib.mock.calls.filter((call) => call[1] === 'file:///geometry-roots.d.ts').slice(-1)[0]
    expect(roots?.[0]).toContain('declare const Notched')
    expect(addExtraLib.mock.calls.slice(-1)[0]?.[1]).toContain('file:///geometries/caemble%3Ageometry')
    expect(disposed).toContain('file:///geometry-roots.d.ts')

    let continueCompilation: () => void = () => undefined
    let compilationStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      compilationStarted = resolve
    })
    const paused = new Promise<void>((resolve) => {
      continueCompilation = resolve
    })
    const compilation = withGeometryTypeEnvironment(
      monaco,
      {
        roots: [{ alias: 'OldRoot', coordinate: 'old' }],
        modules: [{ coordinate: 'old', source: 'export default 1' }],
      },
      true,
      async () => {
        compilationStarted()
        await paused
      },
    )
    await started
    setGeometryAuthoringGraph({
      roots: [{ alias: 'CurrentRoot', coordinate: 'current' }],
      modules: [{ coordinate: 'current', source: 'export default 2' }],
    })
    continueCompilation()
    await compilation
    await vi.waitFor(() => {
      const latestRoots = addExtraLib.mock.calls
        .filter((call) => call[1] === 'file:///geometry-roots.d.ts')
        .slice(-1)[0]?.[0]
      expect(latestRoots).toContain('declare const CurrentRoot')
    })
  })
})
