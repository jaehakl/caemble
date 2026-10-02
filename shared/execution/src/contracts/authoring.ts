/** Compiler and CLI diagnostics preserve the original message/code and report only known positions. */
export type AuthoringDiagnostic = Readonly<{
  stage: string
  language: 'typescript' | 'javascript' | 'python' | 'data'
  code: string
  message: string
  sourceHash?: string
  referenceId: string
  /** One-based start position. A known file without a known position still has location: null. */
  location: Readonly<{ file?: string; line: number; column: number }> | null
  file?: string
  range?: Readonly<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  sourceLine?: string
}>

export type AuthoringErrorMetadata = Readonly<{
  code?: string
  stage?: string
  language?: AuthoringDiagnostic['language']
  sourceHash?: string
  referenceId?: string
  diagnostic?: unknown
  diagnostics?: readonly AuthoringDiagnostic[]
  logs?: readonly string[]
}>
