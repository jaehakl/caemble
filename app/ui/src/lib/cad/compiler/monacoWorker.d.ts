// Monaco ships these worker implementations without declarations. Keep the adapter
// limited to the pinned engine's methods used by the isolated CAD compiler.
declare module 'monaco-editor/languages/features/typescript/ts.worker.js'

declare module 'monaco-editor/languages/features/typescript/tsWorker.js' {
  import type { typescript } from 'monaco-editor'
  import type { LanguageService } from 'typescript'

  export class TypeScriptWorker {
    constructor(
      context: { getMirrorModels(): never[] },
      data: { compilerOptions: typescript.CompilerOptions; extraLibs: typescript.IExtraLibs },
    )
    getLanguageService(): LanguageService
    getSyntacticDiagnostics(file: string): Promise<typescript.Diagnostic[]>
    getSemanticDiagnostics(file: string): Promise<typescript.Diagnostic[]>
    getEmitOutput(file: string): Promise<typescript.EmitOutput>
  }
}

declare module 'monaco-editor/languages/features/typescript/lib/typescriptServices.js' {
  export const typescript: typeof import('typescript')
}
