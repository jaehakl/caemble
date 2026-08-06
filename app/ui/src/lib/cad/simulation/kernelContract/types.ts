import type { CadScene } from '../../evaluation/types'
import type { DataSchema, DataSchemaAxis, ExperimentParameter, ExperimentTarget } from '../../model/descriptor'
import type { UcumUnit } from '../../model/units'

export type KernelArtifactType = `${string}@${number}`

export type KernelDataAxis = DataSchemaAxis
export type KernelDataSpec = DataSchema

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
  source: 'structure' | 'experiment'
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
    data: KernelDataSpec
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
  data?: KernelDataSpec
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
    structure: CadScene
    experiment: CadScene
  }>
}>

export type ResolvedKernelOutputSpec = Readonly<{
  artifactType: KernelArtifactType
  data: KernelDataSpec
}>

export type KernelContractIssue = Readonly<{
  path: string
  message: string
}>
