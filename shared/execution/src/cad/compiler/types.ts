export type CadDiagnostic = Readonly<{
  code: number | string
  file: string
  message: string
  phase: 'policy' | 'semantic' | 'syntax'
  range: Readonly<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  severity: 'error' | 'warning' | 'info'
}>

export type CompiledCadSource = Readonly<{
  entryFile: string
  code: string
  sourceMap?: string
  sourceHash: string
}>

export type CompiledCadDocument = Readonly<{
  sourceHash: string
  sources: Readonly<Record<string, CompiledCadSource>>
}>
