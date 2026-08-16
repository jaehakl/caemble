import type { CompiledCadDocument } from '../compiler/types'
import type { EvaluatedExperimentSnapshot } from '../execution/snapshot'
import type { Tensor } from '../model/types'
import type { UcumUnit } from '../model/units'
import type { VarsSchemaEntry } from '../model/vars'
import type { SerializableCadScene } from '../execution/meshValidation'
import type { GeometryModuleCoordinate } from '../source/effectiveGeometryGraph'
import type { CatalogRuntimeSlice } from '@/contracts/catalog'

export type CadDocumentType = 'experiment'
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

type CadRequestIdentity = Readonly<{
  requestId: string
  revision: number
  compiledDocument: CompiledCadDocument
}>

export type CadInspectionRequest = CadRequestIdentity & Readonly<{ type: 'inspect'; catalog: CatalogRuntimeSlice }>

export type CadEvaluationRequest = CadRequestIdentity &
  Readonly<{
    type: 'evaluate'
    catalog: CatalogRuntimeSlice
    pythonSource: string
    vars: Readonly<Record<string, Tensor>>
  }>

export type CadGeometryPreviewRequest = CadRequestIdentity &
  Readonly<{
    type: 'preview-geometry'
    coordinate: GeometryModuleCoordinate
    exportName: string
    lengthUnit: UcumUnit
  }>

type CadResponseIdentity = Readonly<{
  requestId: string
  revision: number
  documentType: 'experiment' | 'geometry'
}>

export type CadInspectionResponse =
  | (CadResponseIdentity &
      Readonly<{
        type: 'inspection-success'
        sourceHash: string
        varsSchema: Readonly<Record<string, VarsSchemaEntry>>
      }>)
  | (CadResponseIdentity & CadErrorResponse<'inspection-error'>)

export type CadEvaluationResponse =
  | (CadResponseIdentity &
      Readonly<{
        type: 'evaluation-success'
        snapshot: EvaluatedExperimentSnapshot
      }>)
  | (CadResponseIdentity & CadErrorResponse<'evaluation-error'>)

export type CadGeometryPreviewResponse =
  | (CadResponseIdentity &
      Readonly<{
        type: 'geometry-preview-success'
        sourceHash: string
        scene: SerializableCadScene
      }>)
  | (CadResponseIdentity & CadErrorResponse<'geometry-preview-error'>)

type CadErrorResponse<Type extends string> = Readonly<{
  type: Type
  errorType: CadWorkerErrorType
  message: string
  diagnostics?: readonly CadDiagnostic[]
  stack?: string
}>

export type CadWorkerRequest = CadInspectionRequest | CadEvaluationRequest | CadGeometryPreviewRequest
export type CadWorkerResponse = CadInspectionResponse | CadEvaluationResponse | CadGeometryPreviewResponse
