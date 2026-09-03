import type { KernelDescriptor } from './solver'

export type CatalogQuantityKind = Readonly<{
  name: string
  domain: string
  tensorOrder: number
  description?: string | null
  opaque: boolean
  applicableUnits: readonly string[]
}>

export type CatalogMaterialParameter = Readonly<{
  key: string
  domain: string
  labelKo: string
  quantityKind: string
  specialQualifiers: readonly string[]
}>

export type CatalogMaterialModel = Readonly<{
  key: string
  labelKo: string
  kind: 'sampled_relation'
  input: Readonly<{ name: string; quantityKind: string }>
  output: Readonly<{ name: string; quantityKind: string }>
  minimumSamples: number
  sharedBasis: boolean
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
  methodCategory: string
  methodId: string
  description: string
}>

export type CatalogMeta = Readonly<{
  catalogRevision: string
  quantityKindCount: number
  materialParameterCount: number
  materialModelCount: number
  solverCount: number
  experimentCount: number
  materialGlobalQualifiers: readonly string[]
  materialDesignRules: Readonly<Record<string, string>>
}>

export type CatalogQuantityKindDetail = CatalogQuantityKind &
  Readonly<{
    materialParameters: readonly Readonly<{ key: string; labelKo: string }>[]
    solverUsages: readonly QuantityKindUsage[]
  }>

export type CatalogMaterialParameterDetail = CatalogMaterialParameter &
  Readonly<{
    quantityKindDefinition: CatalogQuantityKind
    solverRequirements: readonly MaterialRequirement[]
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
  materialParameters: readonly CatalogMaterialParameter[]
  materialModels: readonly CatalogMaterialModel[]
  materialGlobalQualifiers: readonly string[]
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
  materialParameters: readonly string[]
  materialModels: readonly string[]
}>
