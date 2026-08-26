import type { CadScene } from '../../evaluation/types'
import type { DataSchema, DataSchemaAxis, ExperimentParameter, ExperimentTarget } from '../../model/descriptor'
import type { UcumUnit } from '../../model/units'

export type KernelArtifactType = `${string}@${number}`

export type KernelDataAxis = DataSchemaAxis
export type KernelDataSpec = DataSchema
export type KernelStructuredBundleSpec = Readonly<{
  resourceKind: 'structuredBundle'
  members: Readonly<Record<string, KernelDataSpec>>
}>
export type KernelArtifactDataSpec = KernelDataSpec | KernelStructuredBundleSpec

export type KernelValueSpec = KernelDataSpec &
  Readonly<{
    minimum?: number
    maximum?: number
    exclusiveMinimum?: boolean
    exclusiveMaximum?: boolean
    values?: readonly string[]
    minimumLength?: number
  }>

export type KernelParameterDescriptor = Readonly<{
  description: string
  required?: boolean
  data: KernelValueSpec
}>

export type KernelTargetDescriptor = Readonly<{
  source: 'experiment' | 'task'
  kind: 'geometry' | 'surface'
  minimumTargets: number
  maximumTargets: number
  minimumResolved: number
  maximumResolved: number
}>

export type KernelMethodDescriptor = Readonly<{
  methodId: string
  description: string
  minimumOccurrences: number
  maximumOccurrences: number
  target: KernelTargetDescriptor
  parameters: Readonly<Record<string, KernelParameterDescriptor>>
}>

export type KernelOutputMethodDescriptor = KernelMethodDescriptor &
  Readonly<{
    artifactType: KernelArtifactType
    data: KernelArtifactDataSpec
  }>

export type KernelMaterialDescriptor = Readonly<{
  role: string
  description: string
  target: Readonly<{
    category: 'initializations' | 'boundaryConditions' | 'outputs'
    methodId: string
  }>
  properties: Readonly<Record<string, KernelParameterDescriptor>>
}>

export type KernelInputPortDescriptor = Readonly<{
  description: string
  artifactTypes: readonly KernelArtifactType[]
  minimumOccurrences: number
  maximumOccurrences: number
  data?: KernelArtifactDataSpec
}>

export type KernelObservationDescriptor = Readonly<{
  description: string
  type: 'number' | 'boolean' | 'string'
  required?: boolean
}>

export type KernelDescriptor = Readonly<{
  name: string
  version: string
  description: string
  referenceLengthUnit: UcumUnit
  minimumOutputs?: number
  parameters: Readonly<Record<string, KernelParameterDescriptor>>
  materials: readonly KernelMaterialDescriptor[]
  inputPorts: Readonly<Record<string, KernelInputPortDescriptor>>
  observations: Readonly<Record<string, KernelObservationDescriptor>>
  methods: Readonly<{
    initializations: readonly KernelMethodDescriptor[]
    boundaryConditions: readonly KernelMethodDescriptor[]
    outputs: readonly KernelOutputMethodDescriptor[]
  }>
}>

export type KernelMethodCall = Readonly<{
  methodId: string
  target: readonly ExperimentTarget[]
  parameters: Readonly<Record<string, ExperimentParameter>>
}>

export type KernelOutputRequest = KernelMethodCall &
  Readonly<{
    key: string
  }>

export type KernelTaskConfig = Readonly<{
  parameters: Readonly<Record<string, ExperimentParameter>>
  initializations: readonly KernelMethodCall[]
  boundaryConditions: readonly KernelMethodCall[]
  outputs: readonly KernelOutputRequest[]
}>

export type KernelWorld = Readonly<{
  scenes: Readonly<{
    experiment: CadScene
    task: CadScene
  }>
}>

export type ResolvedKernelOutputSpec = Readonly<{
  artifactType: KernelArtifactType
  data: KernelArtifactDataSpec
}>

export type KernelContractIssue = Readonly<{
  path: string
  message: string
}>
