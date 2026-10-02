import type { CadDiagnostic } from './types'

export class CadCompilationError extends Error {
  readonly diagnostics: readonly CadDiagnostic[]
  readonly errorType: 'compile' | 'policy' | 'type'

  constructor(errorType: 'compile' | 'policy' | 'type', message: string, diagnostics: readonly CadDiagnostic[] = []) {
    super(message)
    this.name = 'CadCompilationError'
    this.errorType = errorType
    this.diagnostics = diagnostics
  }
}
