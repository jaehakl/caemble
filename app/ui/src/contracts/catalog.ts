import type { CalculationDefinition } from './api/calculation'
import type { KernelDescriptor } from './solver'

export type CatalogQuantityKind = Readonly<{
  name: string
  domain: string
  tensorOrder: number
  description?: string | null
  opaque: boolean
  applicableUnits: readonly string[]
}>

export type ModelParameterSchema = Readonly<{ description?: string; omission?: string }> &
  (
    | Readonly<{
        kind: 'value'
        dtype?:
          | 'float16'
          | 'float32'
          | 'float64'
          | 'int8'
          | 'int16'
          | 'int32'
          | 'int64'
          | 'uint8'
          | 'uint16'
          | 'uint32'
          | 'uint64'
          | 'bool'
          | 'string'
        shape?: readonly number[]
        quantityKind?: string
        unit?: string
        minimum?: number
        maximum?: number
        exclusiveMinimum?: boolean
        exclusiveMaximum?: boolean
        values?: readonly string[]
      }>
    | Readonly<{ kind: 'object'; fields: Readonly<Record<string, ModelParameterSchema>>; required?: readonly string[] }>
    | Readonly<{
        kind: 'list'
        items: ModelParameterSchema
        minimumLength?: number
        maximumLength?: number
        increasingBy?: string
      }>
  )

export type CatalogMaterialModel = Readonly<{
  key: string
  labelKo: string
  description: string
  equation: string
  conventions: string
  parameterSchema: ModelParameterSchema
  solverRequirements?: readonly MaterialRequirement[]
}>

export type CatalogSolverListItem = Readonly<{
  name: string
  version: string
  description: string
}>

type QuantityKindUsage = Readonly<{
  solverName: string
  solverVersion: string
  context: string
  path: string
  unit?: string | null
}>

type MaterialRequirement = Readonly<{
  solverName: string
  solverVersion: string
  role: string
  groupKey: string
  required: boolean
}>

export type CatalogMeta = Readonly<{
  catalogRevision: string
  quantityKindCount: number
  materialModelCount: number
  solverCount: number
  experimentCount: number
}>

export type CatalogQuantityKindDetail = CatalogQuantityKind &
  Readonly<{
    materialModels: readonly Readonly<{ key: string; labelKo: string; path: string }>[]
    solverUsages: readonly QuantityKindUsage[]
  }>

export type CatalogSolverDetail = CatalogSolverListItem &
  Readonly<{
    descriptor: KernelDescriptor
    materialRequirements: readonly Readonly<Record<string, unknown>>[]
    quantityKindUsages: readonly Readonly<Record<string, unknown>>[]
    producesArtifacts: readonly Readonly<{
      methodId: string
      artifactType: string
      consumers: readonly Readonly<{ solverName: string; solverVersion: string; inputPort: string }>[]
    }>[]
    consumesArtifacts: readonly Readonly<{
      inputPort: string
      artifactType: string
      producers: readonly Readonly<{ solverName: string; solverVersion: string; methodId: string }>[]
    }>[]
  }>

type ExperimentSolver = Readonly<{ name: string; version: string; description: string }>

export type CatalogExperimentListItem = Readonly<{
  key: string
  namespace: string
  repository: string
  version: string
  coordinate: string
  title: string
  description: string
  bundleHash: string
  concepts: readonly string[]
  relatedSolvers: readonly ExperimentSolver[]
}>

export type CatalogExperimentDetail = CatalogExperimentListItem &
  Readonly<{
    calculations: readonly CalculationDefinition[]
    sourceBundle: Readonly<{ files: Readonly<Record<string, string>> }>
  }>

export type CatalogSearchItem = Readonly<{
  kind: string
  key: string
  title: string
  subtitle: string
}>

export type CatalogRuntimeSlice = Readonly<{
  catalogRevision: string
  solvers: readonly Readonly<{ name: string; version: string; descriptor: KernelDescriptor }>[]
  quantityKinds: readonly CatalogQuantityKind[]
  materialModels: readonly CatalogMaterialModel[]
  warnings: readonly string[]
}>

export type ListQuery = Readonly<{
  q?: string
  domain?: string
  solverName?: string
  solverVersion?: string
  usage?: string
  unit?: string
  tensorOrder?: number
  quantityKind?: string
  namespace?: string
  repository?: string
  version?: string
  limit?: number
  cursor?: string
}>

export type CatalogList<T> = Readonly<{ items: readonly T[]; nextCursor: string | null; total: number }>

export type CatalogRuntimeSliceRequest = Readonly<{
  solvers: readonly Readonly<{ name: string; version: string }>[]
  quantityKinds: readonly string[]
  materialModels: readonly string[]
}>
