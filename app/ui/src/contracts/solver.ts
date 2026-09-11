export type KernelArtifactType = `${string}@${number}`

type KernelFloatDType = 'float16' | 'float32' | 'float64' | 'complex64'
type KernelNonFloatDType =
  'bool' | 'string' | 'int8' | 'int16' | 'int32' | 'int64' | 'uint8' | 'uint16' | 'uint32' | 'uint64'
type KernelVec3 = readonly [number, number, number]
type KernelCartesianBasis = readonly [KernelVec3, KernelVec3, KernelVec3]

export type KernelDataAxis = Readonly<{
  length?: number
  name?: string
  ticks?: readonly (number | string)[]
}> &
  Readonly<{ unit: string; quantityKind: string } | { unit?: never; quantityKind?: never }>

export type KernelDataSpec = Readonly<{ axes?: readonly KernelDataAxis[] }> &
  Readonly<
    | {
        dtype: KernelFloatDType
        unit: string
        quantityKind: string
        basis?: KernelCartesianBasis
      }
    | {
        dtype: KernelNonFloatDType
        unit?: never
        quantityKind?: never
        basis?: never
      }
  >

export type KernelStructuredBundleSpec = Readonly<{
  resourceKind: 'structuredBundle'
  members: Readonly<Record<string, KernelDataSpec>>
}>
export type ResultVisualization = Readonly<{
  kind: 'tensor' | 'bundle' | 'mesh-field' | 'structured-field' | 'polyline'
  coordinateSpace?: 'experiment'
  valuePath?: string
  fieldPath?: string
  nodeIdsPath?: string
  time?: Readonly<{ path: string; axis: number; nodeAxis: number; componentAxis: number }>
  grid?: Readonly<{
    xyzAxes: readonly [number, number, number]
    sampleAxis: number
    sampleKind: 'frequency' | 'time'
    componentAxis: number
  }>
  spatialAxes?: readonly number[]
  components?: readonly string[]
  valueKind?: 'displacement' | 'stress'
  vertices?: string
  offsets?: string
  attributes?: Readonly<Record<string, Readonly<{ path: string; association: 'path' | 'segment' }>>>
}>

export type KernelArtifactDataSpec = (KernelDataSpec | KernelStructuredBundleSpec) &
  Readonly<{
    visualization?: ResultVisualization
    recording?: 'mesh-field' | 'mesh-series' | 'structured-field'
  }>

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
  target:
    | Readonly<{
        category: 'initializations' | 'boundaryConditions' | 'outputs'
        methodId: string
      }>
    | Readonly<{ category: 'geometry'; source: 'experiment' | 'task' }>
  modelGroups: readonly Readonly<{ key: string; required: boolean; oneOf: readonly string[] }>[]
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
  referenceLengthUnit: string
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
