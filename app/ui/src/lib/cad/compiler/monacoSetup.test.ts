import type * as Monaco from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { setupMonaco } from './monacoSetup'

describe('setupMonaco', () => {
  it('configures the Monaco 0.56 public TypeScript contribution', () => {
    const addExtraLib = vi.fn()
    const setCompilerOptions = vi.fn()
    const setEagerModelSync = vi.fn()
    const monaco = {
      typescript: {
        JsxEmit: { React: 2 },
        ModuleKind: { CommonJS: 1 },
        ModuleResolutionKind: { NodeJs: 2 },
        ScriptTarget: { ES2020: 7 },
        typescriptDefaults: {
          addExtraLib,
          setCompilerOptions,
          setEagerModelSync,
        },
      },
    } as unknown as typeof Monaco

    setupMonaco(monaco)

    expect(setCompilerOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        jsx: 2,
        module: 1,
        moduleResolution: 2,
        target: 7,
      }),
    )
    expect(setEagerModelSync).toHaveBeenCalledWith(true)
    expect(addExtraLib).toHaveBeenCalledTimes(3)
    expect(addExtraLib).toHaveBeenCalledWith(expect.any(String), 'file:///node_modules/@caemble/core/index.d.ts')
    expect(addExtraLib).toHaveBeenCalledWith(expect.any(String), 'file:///node_modules/@caemble/kernels/index.d.ts')
    expect(addExtraLib).toHaveBeenCalledWith(expect.any(String), 'file:///node_modules/@caemble/core/cad-jsx.d.ts')
    expect(addExtraLib.mock.calls.flatMap((call) => call).join('\n')).not.toContain('/v2/')
    expect(addExtraLib.mock.calls.flatMap((call) => call).join('\n')).not.toContain('/v3/')
  })
})
