import type { CompiledCadSource } from '../compiler/types'
import type { EvaluatedDocumentSnapshot } from '../execution/snapshot'
import type { Tensor } from '../model/types'
import type { CadDocumentType } from '../source/document'

export type { CadDocumentType } from '../source/document'

export type CadWorkerErrorType = 'compile' | 'type' | 'policy' | 'runtime' | 'model'
export type CadDiagnosticPhase = 'syntax' | 'semantic' | 'policy' | 'runtime' | 'model'

export type CadDiagnostic = Readonly<{
  file: string
  range: Readonly<{
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
  code: string | number
  severity: 'error' | 'warning' | 'info'
  phase: CadDiagnosticPhase
  message: string
}>

export type CadEvaluationRequest = Readonly<{
  type: 'evaluate'
  requestId: string
  revision: number
  document: Readonly<{
    kind: CadDocumentType
    realizationSeed: number
    simulationCode?: string
    simulationCodeHash?: string
  }>
  compiledSource: CompiledCadSource
  vars?: Readonly<Record<string, Tensor>>
}>

export type CadEvaluationResponse =
  | Readonly<{
      type: 'evaluation-success'
      requestId: string
      revision: number
      documentType: CadDocumentType
      snapshot: EvaluatedDocumentSnapshot
    }>
  | Readonly<{
      type: 'evaluation-error'
      requestId: string
      revision: number
      documentType: CadDocumentType
      errorType: CadWorkerErrorType
      message: string
      diagnostics?: readonly CadDiagnostic[]
      stack?: string
    }>
