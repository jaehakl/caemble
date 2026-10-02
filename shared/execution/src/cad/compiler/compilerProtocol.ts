import type { CadDiagnostic, CompiledCadDocument } from './types'

export type CadCompilationInput = Readonly<{
  sourceHash: string
  sources: Readonly<Record<string, string>>
  catalogTypes: string
}>

export type CadCompilationRequest = CadCompilationInput & Readonly<{ type: 'compile-cad'; requestId: number }>

export type CadCompilationResponse =
  | Readonly<{ requestId: number; type: 'success'; document: CompiledCadDocument }>
  | Readonly<{
      requestId: number
      type: 'failure'
      errorType: 'compile' | 'policy' | 'type'
      message: string
      diagnostics: readonly CadDiagnostic[]
    }>
