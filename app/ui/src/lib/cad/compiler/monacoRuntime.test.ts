import { afterAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  environmentAtImport: null as unknown,
  monaco: {
    editor: {},
    languages: {},
    typescript: { typescriptDefaults: {} },
  },
  setupMonaco: vi.fn(),
}))

vi.mock('monaco-editor/editor/editor.worker.js?worker', () => ({
  default: class EditorWorker {},
}))
vi.mock('monaco-editor/languages/features/typescript/ts.worker.js?worker', () => ({
  default: class TypeScriptWorker {},
}))
vi.mock('monaco-editor', () => {
  mocks.environmentAtImport = (globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment
  return mocks.monaco
})
vi.mock('./monacoSetup', () => ({ setupMonaco: mocks.setupMonaco }))

import { loadMonaco } from './monacoRuntime'

describe('loadMonaco', () => {
  afterAll(() => {
    delete (globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment
  })

  it('sets the Worker environment before importing and configures the public Monaco module once', async () => {
    const monaco = await loadMonaco()
    const secondLoad = await loadMonaco()
    const environment = mocks.environmentAtImport as {
      getWorker: (moduleId: string, label: string) => { constructor: { name: string } }
    }

    expect(environment).toBeDefined()
    expect(environment.getWorker('', 'typescript').constructor.name).toBe('TypeScriptWorker')
    expect(environment.getWorker('', 'editorWorkerService').constructor.name).toBe('EditorWorker')
    expect(monaco.editor).toBe(mocks.monaco.editor)
    expect(monaco.languages).toBe(mocks.monaco.languages)
    expect(secondLoad).toBe(monaco)
    expect(mocks.setupMonaco).toHaveBeenCalledOnce()
    expect(mocks.setupMonaco.mock.calls[0]?.[0]).toBe(monaco)
  })
})
