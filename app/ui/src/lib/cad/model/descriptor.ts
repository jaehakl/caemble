import type {
  CartesianBasis,
  QuantityMetadata,
  QuantityKindName,
  ScalarQuantityKindName,
  TensorQuantityKindName,
} from '../../quantitykind/runtime'
import type {
  MaterialModelDefinitionFor,
  MaterialModelKey,
  MaterialPropertyKey,
  MaterialPropertyQuantityKind,
} from '../../material/data'
import type {
  PersistedDataTensor as PersistedDataTensorContract,
  RecordedDataAxis as RecordedDataAxisContract,
} from '@/contracts/cad-persistence'
import type { UcumUnit } from './units'

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
type DataSchemaAxisBase = Readonly<{
  length?: number
  name?: string
  ticks?: readonly (number | string)[]
}>
export type DataSchemaAxis = DataSchemaAxisBase &
  Readonly<{ unit: UcumUnit; quantityKind: ScalarQuantityKindName } | { unit?: never; quantityKind?: never }>
export type DataAxis = DataSchemaAxis & Readonly<{ length: number }>
type DataTypeMetadata = Readonly<
  | ({ dtype: FloatDataDType } & (QuantityMetadata<ScalarQuantityKindName> | QuantityMetadata<TensorQuantityKindName>))
  | {
      dtype: NonFloatDataDType
      unit?: never
      quantityKind?: never
      basis?: never
    }
>
export type DataSchema = Readonly<{ axes?: readonly DataSchemaAxis[] }> & DataTypeMetadata
export type DataValueDescriptor = Readonly<{
  axes?: readonly DataAxis[]
  value: boolean | string | number | readonly unknown[]
}> &
  DataTypeMetadata
export type MatrixValue = readonly (readonly number[])[]
type MaterialInputBasisMetadata<Name extends QuantityKindName> = Readonly<{ basis?: CartesianBasis }> & {
  readonly __quantityKind?: Name
}

export type MaterialDataValueDescriptor<Key extends MaterialPropertyKey = MaterialPropertyKey> =
  Key extends MaterialPropertyKey
    ? Readonly<{
        dtype: FloatDataDType
        value: number | readonly unknown[]
        unit: UcumUnit
        errorRate?: number
        axes?: never
        quantityKind?: never
      }> &
        MaterialInputBasisMetadata<MaterialPropertyQuantityKind<Key>>
    : never

export type ResolvedMaterialDataValueDescriptor<Key extends MaterialPropertyKey = MaterialPropertyKey> =
  Key extends MaterialPropertyKey
    ? Readonly<{
        dtype: FloatDataDType
        value: number | readonly unknown[]
        unit: UcumUnit
        quantityKind: MaterialPropertyQuantityKind<Key>
        errorRate: number
        axes?: never
      }> &
        MaterialInputBasisMetadata<MaterialPropertyQuantityKind<Key>>
    : never

type MaterialModelInputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['input']['quantity_kind']
type MaterialModelOutputQuantityKind<Key extends MaterialModelKey> =
  MaterialModelDefinitionFor<Key>['output']['quantity_kind']

export type MaterialQuantitySeries<Name extends QuantityKindName> = Readonly<{
  unit: UcumUnit
  values: readonly unknown[]
}> &
  MaterialInputBasisMetadata<Name>

export type MaterialSampledRelation<Key extends MaterialModelKey = MaterialModelKey> = Key extends MaterialModelKey
  ? Readonly<{
      kind: 'sampled_relation'
      input: MaterialQuantitySeries<MaterialModelInputQuantityKind<Key>>
      output: MaterialQuantitySeries<MaterialModelOutputQuantityKind<Key>>
    }>
  : never

export type ScalarValue = boolean | string | number
export type MaterialVariable = string | MaterialDataValueDescriptor | MaterialSampledRelation
// The selected runtime slice supplies exact authoring keys to Monaco; application runtime values are validated.
export type MaterialVariables = Readonly<Record<string, any> & { color?: string; errorRate?: number }>
export type NormalizedMaterialVariables = Readonly<Record<string, any> & { color?: string }>
export type ResolvedMaterialVariables = Readonly<Record<string, any> & { color?: string }>
export type ExperimentParameter = ScalarValue | DataValueDescriptor
export type ExperimentParameters = Readonly<Record<string, ExperimentParameter>>
export type RecordedDataResultAxis = DataSchemaAxis
export type RecordedDataResult = DataSchema
export type ExperimentRule<TParameters extends ExperimentParameters = ExperimentParameters> = Readonly<{
  target: readonly ExperimentTarget[]
  label: string
  methodId: string
  parameters: TParameters
}>
export type RecordedDataRule<TParameters extends ExperimentParameters = ExperimentParameters> = Readonly<
  ExperimentRule<TParameters> & { result: RecordedDataResult }
>
export type RecordedDataAxis = RecordedDataAxisContract
export type DataTensor = Readonly<{
  shape: readonly number[]
  axes?: readonly RecordedDataAxis[]
  storage:
    | Readonly<{ kind: 'inline'; value: unknown }>
    | Readonly<{ kind: 'attachments'; ids: readonly string[]; byteLength: number }>
    | Readonly<{ kind: 'base64'; data: string; byteLength: number }>
}>
export type PersistedDataTensor = PersistedDataTensorContract
export type DataTensorInput = Readonly<{
  value: boolean | string | number | readonly unknown[]
  axes?: readonly RecordedDataAxis[]
}>
export type RecordedDataTensor = DataTensor | PersistedDataTensor
export type RecordedDataNode = RecordedDataTensor | RecordedDataGroup
export interface RecordedDataGroup extends Readonly<Record<string, RecordedDataNode>> {}
export interface RecordedData extends Readonly<Record<string, RecordedDataNode>> {}
export function Mat(diagonal: number, offDiagonal = 0, size = 3): MatrixValue {
  return Object.freeze(
    Array.from({ length: size }, (_, row) =>
      Object.freeze(Array.from({ length: size }, (_item, column) => (row === column ? diagonal : offDiagonal))),
    ),
  )
}
