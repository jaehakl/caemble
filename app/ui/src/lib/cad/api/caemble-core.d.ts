// @caemble/core declaration version: 0.5.0
export type Tensor = number | readonly Tensor[]
export type Vars = Readonly<Record<string, Tensor>>
export type Vec3 = readonly [number, number, number]
export type CartesianBasis = readonly [Vec3, Vec3, Vec3]
export type Rotation = Readonly<{ axis: Vec3; angle: number }>
// <generated:primitive-authoring-bindings>
export const Box: 'box'
export const Cylinder: 'cylinder'
export const CurvedEdgeCylinder: 'curvedEdgeCylinder'
export const Sphere: 'sphere'
export const CurvedSurfaceSphere: 'curvedSurfaceSphere'
export const Fiber: 'fiber'
// </generated:primitive-authoring-bindings>
export function radians(degrees: number): number
export function radians(degrees: Vec3): Vec3
export type CanonicalGeometryTransformAttributes = Readonly<{
  position?: Vec3
  rotation?: Vec3
  pos?: never
  rotate?: never
  scale?: Vec3
}>
export type LegacyGeometryTransformAttributes = Readonly<{
  position?: never
  rotation?: never
  /** @deprecated Use position. */
  pos?: Vec3
  /** @deprecated Use rotation with XYZ Euler angles in radians. */
  rotate?: Rotation
  scale?: Vec3
}>
export type GeometryTransformAttributes = CanonicalGeometryTransformAttributes | LegacyGeometryTransformAttributes
export type GeometryIdentityAttributes = Readonly<{ id?: string }>
export type IntrinsicGeometryAttributes = GeometryIdentityAttributes & GeometryTransformAttributes
export type GeometryGroupMap = Readonly<Record<string, readonly string[]>>
export type VarsSchemaEntry = Readonly<{
  min: Tensor
  max: Tensor
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
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
export type LegacyRecordedDataTensor = Readonly<{
  value: boolean | string | number | readonly unknown[]
  axes?: readonly RecordedDataAxis[]
}>
export type RecordedDataTensor = DataTensor | PersistedDataTensor | LegacyRecordedDataTensor
export type RecordedData = Readonly<Record<string, RecordedDataTensor>>
export type RecordedDataSpec = RecordedDataResult
export type ResolvedDataSchema = RecordedDataSpec & Readonly<{ tensorOrder: number }>

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
// Catalog keys are augmented in memory from the active Solver runtime slice.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MaterialPropertyQuantityKindMap {}
export type MaterialPropertyKey = keyof MaterialPropertyQuantityKindMap extends never
  ? string
  : keyof MaterialPropertyQuantityKindMap
export type MaterialPropertyQuantityKind<Key extends MaterialPropertyKey> =
  Key extends keyof MaterialPropertyQuantityKindMap ? MaterialPropertyQuantityKindMap[Key] : QuantityKindName
export type MaterialPropertyDefinitionFor<Key extends MaterialPropertyKey> = Readonly<{
  key: Key
  quantity_kind: MaterialPropertyQuantityKind<Key>
}>

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface MaterialModelDefinitionMap {}
export type MaterialModelKey = keyof MaterialModelDefinitionMap extends never
  ? string
  : keyof MaterialModelDefinitionMap
export type MaterialModelDefinitionFor<Key extends MaterialModelKey> = Key extends keyof MaterialModelDefinitionMap
  ? MaterialModelDefinitionMap[Key]
  : Readonly<{
      key: Key
      kind: 'sampled_relation'
      input: Readonly<{ quantity_kind: QuantityKindName }>
      output: Readonly<{ quantity_kind: QuantityKindName }>
      minimum_samples: number
      shared_basis: boolean
    }>
export type MaterialCatalogKey = MaterialPropertyKey | MaterialModelKey

type MaterialAuthoringBasis<Name extends QuantityKindName> = Name extends ScalarQuantityKindName
  ? Readonly<{ basis?: never }>
  : Readonly<{ basis?: CartesianBasis }>
type MaterialNormalizedBasis<Name extends QuantityKindName> = Name extends ScalarQuantityKindName
  ? Readonly<{ basis?: never }>
  : Readonly<{ basis: CartesianBasis }>

export type MaterialDataValueDescriptor<Key extends MaterialPropertyKey = MaterialPropertyKey> =
  Key extends MaterialPropertyKey
    ? Readonly<{
        dtype: FloatDataDType
        value: number | readonly unknown[]
        unit: ApplicableUnit<MaterialPropertyQuantityKind<Key>>
        errorRate?: number
        axes?: never
        quantityKind?: never
      }> &
        MaterialAuthoringBasis<MaterialPropertyQuantityKind<Key>>
    : never

export type NormalizedMaterialDataValueDescriptor<Key extends MaterialPropertyKey = MaterialPropertyKey> =
  Key extends MaterialPropertyKey
    ? Readonly<{
        dtype: FloatDataDType
        value: number | readonly unknown[]
        unit: UcumUnit
        quantityKind: MaterialPropertyQuantityKind<Key>
        errorRate: number
        axes?: never
      }> &
        MaterialNormalizedBasis<MaterialPropertyQuantityKind<Key>>
    : never

type MaterialModelInputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['input']['quantity_kind']
type MaterialModelOutputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['output']['quantity_kind']
export type MaterialQuantitySeries<Name extends QuantityKindName> = Readonly<{
  unit: ApplicableUnit<Name>
  values: readonly unknown[]
}> &
  MaterialAuthoringBasis<Name>
export type MaterialSampledRelation<Key extends MaterialModelKey = MaterialModelKey> = Key extends MaterialModelKey
  ? Readonly<{
      kind: 'sampled_relation'
      input: MaterialQuantitySeries<MaterialModelInputQuantityKind<Key>>
      output: MaterialQuantitySeries<MaterialModelOutputQuantityKind<Key>>
    }>
  : never

export type MaterialVariable = string | MaterialDataValueDescriptor | MaterialSampledRelation
export type MaterialVariables = keyof MaterialPropertyQuantityKindMap extends never
  ? Readonly<Record<string, unknown> & { color?: string; errorRate?: number }>
  : Readonly<
      { [Key in keyof MaterialPropertyQuantityKindMap]?: MaterialDataValueDescriptor<Key> } & {
        [Key in keyof MaterialModelDefinitionMap]?: MaterialSampledRelation<Key>
      } & { color?: string; errorRate?: number }
    >
export type NormalizedMaterialVariables = keyof MaterialPropertyQuantityKindMap extends never
  ? Readonly<Record<string, unknown> & { color?: string }>
  : Readonly<
      { [Key in keyof MaterialPropertyQuantityKindMap]?: NormalizedMaterialDataValueDescriptor<Key> } & {
        [Key in keyof MaterialModelDefinitionMap]?: MaterialSampledRelation<Key>
      } & { color?: string }
    >
export type ResolvedMaterialVariables = NormalizedMaterialVariables
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
export function assertUcumUnitComparable(
  unit: UcumUnit | undefined,
  expectedUnit: UcumUnit | undefined,
  path: string,
): void
export function isFloatDType(dtype: DataDType): boolean
export function Mat(diagonal: number, offDiagonal?: number, size?: number): MatrixValue

export class Material {
  constructor(name: string)
  constructor(name: string, variables: MaterialVariables)
  constructor(name: string, sourceVersion: string)
  constructor(name: string, sourceVersion: string, variables: MaterialVariables)
  readonly name: string
  readonly source?: string
  readonly version?: string
  readonly errorRate: number
  readonly variables: NormalizedMaterialVariables
}

export type VarsSchemaDefinition = Readonly<Record<string, Readonly<VarsSchemaEntry>>>

type ShapeSource<Entry extends VarsSchemaEntry> = Entry['min'] extends readonly unknown[] ? Entry['min'] : Entry['max']

type WidenTensor<Value> = Value extends number
  ? number
  : Value extends readonly unknown[]
    ? { readonly [Index in keyof Value]: WidenTensor<Value[Index]> }
    : never

export type InferVars<Schema extends VarsSchemaDefinition> = Readonly<{
  [Key in keyof Schema]: WidenTensor<ShapeSource<Schema[Key]>>
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
  Recorded extends Readonly<Record<string, RecordedDataSpec>>,
> = Readonly<{
  geometry: (context: ModelContext<Schema>) => unknown
  lengthUnit: UcumUnit
  varsSchema: Schema
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: GeometryGroupMap
  recordedData: Recorded
}>

export type TaskDefinitionOptions<Config> = Readonly<{
  kernel: KernelIdentity
  lengthUnit?: UcumUnit
  geometry?: (context: TaskModelContext) => unknown
  geometryGroup?: GeometryGroupMap
  surfaceGroup?: GeometryGroupMap
  config: (context: TaskModelContext) => Config
}>

export class ExperimentDefinition<
  Schema extends VarsSchemaDefinition = VarsSchemaDefinition,
  Recorded extends Readonly<Record<string, RecordedDataSpec>> = Readonly<Record<string, RecordedDataSpec>>,
> {
  constructor(options: ExperimentDefinitionOptions<Schema, Recorded>)
  readonly apiVersion: 8
  readonly documentType: 'experiment'
  readonly varsSchema: Schema
  readonly lengthUnit: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: GeometryGroupMap
  readonly recordedData: Recorded
}

export class TaskDefinition<Config = unknown> {
  constructor(options: TaskDefinitionOptions<Config>)
  readonly apiVersion: 8
  readonly documentType: 'task'
  readonly kernel: KernelIdentity
  readonly lengthUnit?: UcumUnit
  readonly geometryGroup: GeometryGroupMap
  readonly surfaceGroup: GeometryGroupMap
}

export declare function experiment<
  const Schema extends VarsSchemaDefinition,
  const Recorded extends Readonly<Record<string, RecordedDataSpec>>,
>(options: ExperimentDefinitionOptions<Schema, Recorded>): ExperimentDefinition<Schema, Recorded>

export declare function defineTask<const Config>(options: TaskDefinitionOptions<Config>): TaskDefinition<Config>

export type SimulationProgramManifest = Readonly<{
  formatVersion: 5
  simulationApiVersion: 3
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
  recordedData: Readonly<Record<string, ResolvedDataSchema>>
}>

export type ExternalVars = Readonly<Record<string, Tensor>>
