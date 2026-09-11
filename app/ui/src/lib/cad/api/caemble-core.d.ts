// Generated @caemble/core declaration.
export type Tensor = number | readonly Tensor[]
export type Vars = Readonly<Record<string, Tensor>>
export type Vec3 = readonly [number, number, number]
export type CartesianBasis = readonly [Vec3, Vec3, Vec3]
export type Rotation = Readonly<{ axis: Vec3; angle: number }>
// <generated:primitive-authoring-bindings>
export const Box: (props: BoxAttributes) => unknown
export const Cylinder: (props: CylinderAttributes) => unknown
export const CurvedEdgeCylinder: (props: CurvedEdgeCylinderAttributes) => unknown
export const Sphere: (props: SphereAttributes) => unknown
export const CurvedSurfaceSphere: (props: CurvedSurfaceSphereAttributes) => unknown
export const Fiber: (props: FiberAttributes) => unknown
// </generated:primitive-authoring-bindings>
export function radians(degrees: number): number
export function radians(degrees: Vec3): Vec3
export type CanonicalGeometryTransformAttributes = Readonly<{
  position?: Vec3
  rotation?: Vec3
  scale?: Vec3
}>
export type GeometryTransformAttributes = CanonicalGeometryTransformAttributes
export type GeometryIdentityAttributes = Readonly<{ id?: string }>
export type IntrinsicGeometryAttributes = GeometryIdentityAttributes & GeometryTransformAttributes
export type GeometryGroupMap = Readonly<Record<string, readonly string[]>>
export type GeometrySurfaceRef = `${string}/surface/${number}`
export type SurfaceGroupMap = Readonly<Record<string, readonly GeometrySurfaceRef[]>>
export type VarsSchemaEntry = Readonly<{
  shape: readonly number[]
  min: number
  max: number
}>
export type ExperimentTarget = `${'experiment' | 'task'}.${'geometry' | 'surface'}.${string}`
export type DataDType =
  | 'bool'
  | 'string'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'float16'
  | 'float32'
  | 'float64'
export type FloatDataDType = Extract<DataDType, `float${number}`>
export type NonFloatDataDType = Exclude<DataDType, FloatDataDType>
export type IntegerDataDType = Exclude<NonFloatDataDType, 'bool' | 'string'>
export type UcumUnit = string
// <generated:quantity-kind-types>
export interface CatalogQuantityKindMap {}
export type QuantityKindName = keyof CatalogQuantityKindMap extends never ? string : keyof CatalogQuantityKindMap
export type QuantityKindDomain = string
export type QuantityKindNameForDomain<Domain extends QuantityKindDomain> = keyof CatalogQuantityKindMap extends never
  ? string & { readonly __domain?: Domain }
  : {
      [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['domain'] extends Domain ? Name : never
    }[keyof CatalogQuantityKindMap]
export type TensorQuantityKindName = keyof CatalogQuantityKindMap extends never
  ? string
  : {
      [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? never : Name
    }[keyof CatalogQuantityKindMap]
export type ScalarQuantityKindName = keyof CatalogQuantityKindMap extends never
  ? string
  : {
      [Name in keyof CatalogQuantityKindMap]: CatalogQuantityKindMap[Name]['tensorOrder'] extends 0 ? Name : never
    }[keyof CatalogQuantityKindMap]
export type ApplicableUnit<Name extends QuantityKindName> = Name extends keyof CatalogQuantityKindMap
  ? CatalogQuantityKindMap[Name]['applicableUnits'][number]
  : UcumUnit
// </generated:quantity-kind-types>
type QuantityBasisMetadata<Name extends QuantityKindName> = keyof CatalogQuantityKindMap extends never
  ? Readonly<{ basis?: CartesianBasis }>
  : [Name] extends [ScalarQuantityKindName]
    ? Readonly<{ basis?: never }>
    : [Name] extends [TensorQuantityKindName]
      ? Readonly<{ basis?: CartesianBasis }>
      : Readonly<{ basis?: CartesianBasis }>
export type QuantityMetadata<Name extends QuantityKindName = QuantityKindName> = Readonly<{
  unit: ApplicableUnit<Name>
  quantityKind: Name
}> &
  QuantityBasisMetadata<Name>
type DataSchemaAxisBase = Readonly<{
  length?: number
  name?: string
  ticks?: readonly (number | string)[]
}>
export type DataSchemaAxis = DataSchemaAxisBase &
  Readonly<{ unit: UcumUnit; quantityKind: ScalarQuantityKindName } | { unit?: never; quantityKind?: never }>
export type DataAxis = DataSchemaAxis & Readonly<{ length: number }>
type DataTypeMetadata = Readonly<
  | ({
      dtype: FloatDataDType
    } & (QuantityMetadata<ScalarQuantityKindName> | QuantityMetadata<TensorQuantityKindName>))
  | {
      dtype: NonFloatDataDType
      unit?: never
      quantityKind?: never
      basis?: never
    }
>
export type DataSchema = Readonly<{
  axes?: readonly DataSchemaAxis[]
}> &
  DataTypeMetadata
export type DataValueDescriptor = Readonly<{
  axes?: readonly DataAxis[]
  value: boolean | string | number | readonly unknown[]
}> &
  DataTypeMetadata
export type MatrixValue = readonly (readonly number[])[]
export type ScalarValue = boolean | string | number
export type ExperimentParameter = ScalarValue | DataValueDescriptor
export type ExperimentParameters = Readonly<Record<string, ExperimentParameter>>
export type RecordedDataResultAxis = DataSchemaAxis
export type RecordedDataResult = DataSchema
export type RecordedDataAxis = Readonly<{
  ticks?: readonly (number | string)[]
  implicitOrdinal?: true
}>
export type DataTensor = Readonly<{
  shape: readonly number[]
  axes?: readonly RecordedDataAxis[]
  storage:
    | Readonly<{ kind: 'inline'; value: unknown }>
    | Readonly<{ kind: 'attachments'; ids: readonly string[]; byteLength: number }>
    | Readonly<{ kind: 'base64'; data: string; byteLength: number }>
}>
export type PersistedDataTensor = DataTensor & Readonly<{ tensorEncodingVersion: 1 }>
export type DataTensorInput = Readonly<{
  value: boolean | string | number | readonly unknown[]
  axes?: readonly RecordedDataAxis[]
}>
export type RecordedDataTensor = DataTensor | PersistedDataTensor
export type RecordedDataNode = RecordedDataTensor | RecordedDataGroup
export interface RecordedDataGroup extends Readonly<Record<string, RecordedDataNode>> {}
export interface RecordedData extends Readonly<Record<string, RecordedDataNode>> {}
export type RecordedDataSpec = RecordedDataResult
export type ResolvedDataSchema = RecordedDataSpec & Readonly<{ tensorOrder: number }>
export type RecordedOutputReference = Readonly<{ task: string; output: string }>
export type RecordedDataSpecNode = RecordedDataSpec | RecordedOutputReference | RecordedDataSpecGroup
export interface RecordedDataSpecGroup extends Readonly<Record<string, RecordedDataSpecNode>> {}
export type ResolvedDataSchemaNode = ResolvedDataSchema | ResolvedDataSchemaGroup
export interface ResolvedDataSchemaGroup extends Readonly<Record<string, ResolvedDataSchemaNode>> {}

export type BoxAttributes = Readonly<{
  size?: Vec3
}> &
  IntrinsicGeometryAttributes
export type BooleanAttributes = Readonly<{
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export type CylinderAttributes = Readonly<{
  radius?: number
  radius_2?: number
  height?: number
  segments?: number
}> &
  IntrinsicGeometryAttributes

export type CurvedEdgeCylinderFourierMode = Readonly<{
  amplitude: number
  phase: number
}>
export type CurvedEdgeCylinderTaylorCurve = Readonly<{
  origin: number
  coefficients: readonly number[]
}>
export type CurvedEdgeCylinderAttributes = Readonly<{
  height?: number
  azimuthalCurve?: readonly CurvedEdgeCylinderFourierMode[]
  verticalCurve?: CurvedEdgeCylinderTaylorCurve
  azimuthalSegments?: number
  verticalSegments?: number
}> &
  IntrinsicGeometryAttributes

export type CurvedSurfaceSphereFourierMode = Readonly<{
  amplitude: number
  phase: number
}>
export type CurvedSurfaceSphereAttributes = Readonly<{
  azimuthalCurve?: readonly CurvedSurfaceSphereFourierMode[]
  polarCurve?: readonly CurvedSurfaceSphereFourierMode[]
  azimuthalSegments?: number
  polarSegments?: number
}> &
  IntrinsicGeometryAttributes

export type SphereAttributes = Readonly<{
  radius?: number
  segments?: number
}> &
  IntrinsicGeometryAttributes

export type FiberFourierMode = Readonly<{ amplitude: number; phase: number }>
export type FiberHelix = Readonly<{
  turns: number
  phase?: number
  radius: number | ((u: number, theta: number) => number)
}>
export type FiberAttributes = Readonly<{
  from?: Vec3
  to?: Vec3
  basePath?: (t: number) => Vec3
  radius?: number | ((s: number) => number)
  helix?: FiberHelix
  fourier?: readonly FiberFourierMode[]
  envelopePower?: number
  up?: Vec3
  pathSegments?: number
  radialSegments?: number
}> &
  IntrinsicGeometryAttributes

export type ArrayAttributes = Readonly<{
  shape: readonly [number, number, number]
  period: Vec3
  axes?: Readonly<{ x: Vec3; y: Vec3; z: Vec3 }>
  inject?: Readonly<Record<string, Tensor | Readonly<{ axis: Tensor; angle: Tensor }>>>
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export type TranslateAttributes = Readonly<{
  offset: Vec3
  children?: unknown
}> &
  GeometryIdentityAttributes

export type RotateAttributes = Readonly<{
  axis: Vec3
  angle: number
  children?: unknown
}> &
  GeometryIdentityAttributes

export type ScaleAttributes = Readonly<{
  x: number
  y: number
  z: number
  children?: unknown
}> &
  GeometryIdentityAttributes

export type ShellAttributes = Readonly<{
  offsets: Readonly<Record<string, number>>
  children?: unknown
}> &
  IntrinsicGeometryAttributes

export type GeometryAttributes<P extends object = object> = Readonly<
  P & {
    id: string
    materials?: Readonly<Record<string, Material | undefined>>
    children?: unknown
  }
> &
  GeometryTransformAttributes
export type Geometry<P extends object = object> = (props: GeometryAttributes<P>) => unknown
export type GeometryInvocationAttributes<P extends object = object> = Readonly<
  Partial<P> & {
    id?: string
    materials?: Readonly<Record<string, Material | undefined>>
    children?: unknown
  }
> &
  GeometryTransformAttributes

// <generated:material-catalog-types>
// Model input types are augmented in memory from the active Catalog slice.
export interface MaterialModelParameterMap {}
export type MaterialModelKey = keyof MaterialModelParameterMap extends never ? string : keyof MaterialModelParameterMap
export type MaterialModelInstance = keyof MaterialModelParameterMap extends never
  ? Readonly<{ model: string; parameters: Readonly<Record<string, unknown>> }>
  : {
      [Key in keyof MaterialModelParameterMap]: Readonly<{ model: Key; parameters: MaterialModelParameterMap[Key] }>
    }[keyof MaterialModelParameterMap]
export type MaterialOptions = Readonly<{ color?: string; models?: Readonly<Record<string, MaterialModelInstance>> }>
// </generated:material-catalog-types>

export class CadModelError extends Error {
  constructor(message: string)
}

export function normalizeUcumUnit(value: unknown, path: string): UcumUnit
export function convertUcumValue(
  value: number,
  fromUnit: UcumUnit | undefined,
  toUnit: UcumUnit | undefined,
  path?: string,
): number
export function isFloatDType(dtype: DataDType): boolean
export function Mat<Size extends number = 3>(
  diagonal: number,
  offDiagonal?: number,
  size?: Size,
): TensorForShape<readonly [Size, Size]>

export class Material {
  constructor(name: string, options?: MaterialOptions)
  readonly name: string
  readonly color?: string
  readonly models: Readonly<Record<string, MaterialModelInstance>>
}

export type VarsSchemaDefinition = Readonly<
  Record<string, Readonly<{ shape?: readonly number[]; min: number; max: number }>>
>

type FixedLengthTensor<
  Length extends number,
  Value,
  Result extends readonly Value[] = readonly [],
> = number extends Length
  ? readonly Value[]
  : Result['length'] extends Length
    ? Result
    : Result['length'] extends 32
      ? readonly Value[]
      : FixedLengthTensor<Length, Value, readonly [...Result, Value]>

type TensorForShape<Shape extends readonly number[]> = number extends Shape['length']
  ? Tensor
  : Shape extends readonly []
    ? number
    : Shape extends readonly [infer Length extends number, ...infer Rest extends readonly number[]]
      ? FixedLengthTensor<Length, TensorForShape<Rest>>
      : never

type TensorForSchemaEntry<Entry extends VarsSchemaDefinition[string]> =
  Entry extends Readonly<{
    shape: infer Shape extends readonly number[]
  }>
    ? TensorForShape<Shape>
    : number

export type InferVars<Schema extends VarsSchemaDefinition> = Readonly<{
  [Key in keyof Schema]: TensorForSchemaEntry<Schema[Key]>
}>

export type ModelContext<Schema extends VarsSchemaDefinition> = Readonly<{
  vars: InferVars<Schema>
}>

export type TaskModelContext = Readonly<{
  vars: Readonly<Vars>
}>

export type KernelIdentity = Readonly<{
  name: string
  version: string
}>

export type ExperimentDefinitionOptions<
  Schema extends VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedOutputReference>>,
> = Readonly<{
  geometry: (context: ModelContext<Schema>) => unknown
  lengthUnit: UcumUnit
  varsSchema: Schema
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: SurfaceGroupMap
  recordedData: Recorded
}>

export type TaskDefinitionOptions<Config> = Readonly<{
  kernel: KernelIdentity
  lengthUnit?: UcumUnit
  geometry?: (context: TaskModelContext) => unknown
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: SurfaceGroupMap
  config: (context: TaskModelContext) => Config
}>

export class ExperimentDefinition<
  Schema extends VarsSchemaDefinition = VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedOutputReference>> = Readonly<
    Record<string, RecordedOutputReference>
  >,
> {
  constructor(options: ExperimentDefinitionOptions<Schema, Recorded>)
  readonly documentType: 'experiment'
  readonly varsSchema: Readonly<Record<string, VarsSchemaEntry>>
  readonly lengthUnit: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
  readonly recordedData: Recorded
}

export class TaskDefinition<Config = unknown> {
  constructor(options: TaskDefinitionOptions<Config>)
  readonly documentType: 'task'
  readonly kernel: KernelIdentity
  readonly lengthUnit?: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: SurfaceGroupMap
}

export declare function experiment<
  const Schema extends VarsSchemaDefinition,
  const Recorded extends Readonly<Record<string, RecordedOutputReference>>,
>(options: ExperimentDefinitionOptions<Schema, Recorded>): ExperimentDefinition<Schema, Recorded>

export declare function defineTask<const Config>(options: TaskDefinitionOptions<Config>): TaskDefinition<Config>

export type SimulationProgramManifest = Readonly<{
  pythonSource: string
  tasks: Readonly<
    Record<
      string,
      Readonly<{
        kernel: KernelIdentity
        config: unknown
      }>
    >
  >
  recordedData: Readonly<Record<string, ResolvedDataSchemaNode>>
}>

export type ExternalVars = Readonly<Record<string, Tensor>>
