import type * as Monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'
import { setupMonaco } from './monacoSetup'

let runtime: Promise<typeof Monaco> | null = null

export function loadMonaco() {
  if (!runtime) {
    const environment = {
      getWorker(_moduleId: string, label: string) {
        return label === 'typescript' || label === 'javascript' ? new TypeScriptWorker() : new EditorWorker()
      },
    }
    ;(globalThis as typeof globalThis & { MonacoEnvironment?: typeof environment }).MonacoEnvironment = environment
    runtime = import('monaco-editor').then((monaco) => {
      setupMonaco(monaco)
      return monaco
    })
  }
  return runtime
}

export function prefetchMonaco() {
  void loadMonaco()
}
