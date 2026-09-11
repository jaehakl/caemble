export { CadModelError, isFloatDType, Mat, Material, normalizeDataValueDescriptor, radians } from './core'
export { defineTask, experiment, ExperimentDefinition, TaskDefinition } from './definition'
export type {
  CadDefinition,
  ExperimentDefinitionOptions,
  ExternalVars,
  InferVars,
  ModelContext,
  TaskDefinitionOptions,
  TaskModelContext,
  VarsSchemaDefinition,
} from './definition'
export { generateRandomVars, normalizeVars, normalizeVarsSchema, varsFingerprint, varsSchemaFingerprint } from './vars'
export { flattenVarsTensor, tensorElementCount, varsTensorFromFlat } from './tensor'
export { convertUcumValue, normalizeUcumUnit } from './units'
export type { UcumUnit } from './units'
export type { Rotation, Tensor, Vars, Vec3 } from './types'
export type {
  CanonicalGeometryTransformAttributes,
  CartesianBasis,
  DataAxis,
  DataDType,
  Complex64Value,
  DataSchema,
  DataSchemaAxis,
  DataTensor,
  DataTensorInput,
  DataValueDescriptor,
  ExperimentParameter,
  ExperimentParameters,
  ExperimentTarget,
  FloatDataDType,
  Geometry,
  GeometryAttributes,
  GeometryGroupMap,
  GeometryIdentityAttributes,
  GeometryInvocationAttributes,
  GeometrySurfaceRef,
  GeometryTransformAttributes,
  IntegerDataDType,
  IntrinsicGeometryAttributes,
  MatrixValue,
  NonFloatDataDType,
  PersistedDataTensor,
  QuantityKindDomain,
  QuantityKindName,
  QuantityKindNameForDomain,
  QuantityMetadata,
  RecordedData,
  RecordedDataAxis,
  RecordedDataGroup,
  RecordedDataNode,
  RecordedDataResult,
  RecordedDataResultAxis,
  RecordedDataRule,
  RecordedDataTensor,
  ScalarQuantityKindName,
  ScalarValue,
  SurfaceGroupMap,
  TensorQuantityKindName,
  VarsSchemaEntry,
} from './core'
export { normalizeRecordedData, normalizeRecordedDataTensor } from './recordedData'
export type { ResolvedRecordedTensor } from './recordedData'
export { type PolylineBundle } from './rayPaths'
export {
  DATA_TENSOR_ATTACHMENT_SHARD_BYTES,
  DATA_TENSOR_INLINE_BYTES,
  createAttachmentDataTensor,
  createDataTensor,
  createDataTensorAccessor,
  isDataTensor,
  persistDataSchema,
  persistDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
  shardDataTensorBytes,
} from './dataTensor'
export type { DataTensorAccessor } from './dataTensor'
