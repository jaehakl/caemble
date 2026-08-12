export { evaluateCad, evaluateCadScene } from './evaluation/evaluator'
export { cadElementCatalog } from './catalog'
export { applyCadSceneGroups } from './evaluation/groups'
export { Fragment, h } from './evaluation/jsx'
export type {
  CadScene,
  CadSceneGroup,
  CadSceneMaterial,
  CadScenePart,
  CadSceneSurface,
  CadSceneTreeNode,
} from './evaluation/types'
export { CadModelError, isFloatDType, Mat, Material } from './model/core'
export {
  defineTask,
  experiment,
  ExperimentDefinition,
  TaskDefinition,
} from './model/v5'
export type {
  CadDefinition,
  ExperimentDefinitionOptions,
  ExternalVars,
  InferVars,
  ModelContext,
  TaskDefinitionOptions,
  TaskModelContext,
  VarsSchemaDefinition,
} from './model/v5'
export { generateRandomVars } from './model/vars'
export { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit } from './model/units'
export { normalizeDataValueDescriptor } from './model/core'
export type {
  CartesianBasis,
  DataAxis,
  DataDType,
  DataSchema,
  DataSchemaAxis,
  DataTensor,
  DataValueDescriptor,
  FloatDataDType,
  ExperimentParameter,
  ExperimentParameters,
  ExperimentTarget,
  Geometry,
  GeometryAttributes,
  IntegerDataDType,
  LegacyRecordedDataTensor,
  MaterialDataValueDescriptor,
  MaterialQuantitySeries,
  MaterialSampledRelation,
  MaterialVariable,
  MaterialVariables,
  MatrixValue,
  NonFloatDataDType,
  NormalizedMaterialVariables,
  PersistedDataTensor,
  QuantityKindDomain,
  QuantityKindName,
  QuantityKindNameForDomain,
  QuantityMetadata,
  RecordedData,
  RecordedDataAxis,
  RecordedDataResult,
  RecordedDataResultAxis,
  RecordedDataRule,
  RecordedDataTensor,
  ResolvedMaterialVariables,
  ScalarQuantityKindName,
  ScalarValue,
  GeometryGroupMap,
  TensorQuantityKindName,
  VarsSchemaEntry,
} from './model/core'
export type { UcumUnit } from './model/units'
export type { Rotation, Tensor, Vars, Vec3 } from './model/types'
export { createSolidPointTester } from './geometry/solid'
export type { SolidPointTester } from './geometry/solid'
export type {
  MaterialCatalogKey,
  MaterialModelDefinition,
  MaterialModelDefinitionFor,
  MaterialModelKey,
  MaterialPropertyDefinition,
  MaterialPropertyDefinitionFor,
  MaterialPropertyKey,
  MaterialPropertyQuantityKind,
} from '../material/data'
export {
  CAD_SOURCE_API_VERSION,
  CAD_SOURCE_FORMAT_VERSION,
  MAX_CAD_SOURCE_BYTES,
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_SIMULATION_PATH,
  EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION,
  addExperimentTask,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  cadSource,
  cadSourceHash,
  createCadSourceDocument,
  createExperimentSourceBundle,
  experimentSourceFile,
  experimentTaskName,
  experimentTaskPaths,
  removeExperimentTask,
  updateCadSource,
  updateExperimentSourceFile,
} from './source/document'
export type {
  CadDocumentType,
  CadEvaluationInput,
  CadSourceDocument,
  ExperimentSourceBundle,
  ExperimentSourceDocument,
} from './source/document'
export { CadDocumentEvaluationError, evaluateDocument, inspectDocument } from './execution/evaluateDocument'
export type { CadDocumentInspection, EvaluateDocumentOptions } from './execution/evaluateDocument'
export { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './execution/snapshot'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedRuntimeDocumentSnapshot,
} from './execution/snapshot'
export {
  applyFrozenMaterialParameters,
  assertBuiltMeasurement,
  buildMeasurement,
  buildSourceOnlyMeasurement,
} from './execution/measurement'
export type {
  BuiltMeasurement,
  MeasurementMaterialResolution,
  TaskMaterialResolution,
} from './execution/measurement'
export { assertSerializableCadScene, deserializeCadScene, serializeCadScene } from './execution/mesh'
export type { SerializableCadMesh, SerializableCadScene, SerializableCadScenePart } from './execution/mesh'
export { normalizeRecordedData, normalizeRecordedDataTensor } from './model/recordedData'
export type { ResolvedRecordedTensor } from './model/recordedData'
export {
  DATA_TENSOR_ATTACHMENT_SHARD_BYTES,
  DATA_TENSOR_INLINE_BYTES,
  MAX_RECORDED_DATA_BYTES,
  createAttachmentDataTensor,
  createDataTensor,
  createDataTensorAccessor,
  isDataTensor,
  persistDataSchema,
  persistDataTensor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
  shardDataTensorBytes,
} from './model/dataTensor'
export type { DataTensorAccessor } from './model/dataTensor'
export { CadCompilationError, compileCadDocument } from './compiler/monacoCompiler'
export type { CadDiagnostic as CompilerDiagnostic, CompiledCadDocument, CompiledCadSource } from './compiler/types'
export {
  cadSemanticHash,
  compiledCadDocumentSemanticHash,
  compiledCadSemanticHash,
  rawCodeHash,
} from './compiler/semanticHash'
export { evaluateInIsolatedRunner, inspectInIsolatedRunner } from './runner/client'
export type { ArrayAttributes } from './elements/operations/array/definition'
export type { BooleanAttributes } from './elements/operations/booleans/definition'
export type { ShellAttributes } from './elements/operations/shell/definition'
export type { BoxAttributes } from './elements/primitives/box/definition'
export type { CylinderAttributes } from './elements/primitives/cylinder/definition'
export type {
  CurvedEdgeCylinderAttributes,
  CurvedEdgeCylinderFourierMode,
  CurvedEdgeCylinderTaylorCurve,
} from './elements/primitives/curvedEdgeCylinder/definition'
export type {
  CurvedSurfaceSphereAttributes,
  CurvedSurfaceSphereFourierMode,
} from './elements/primitives/curvedSurfaceSphere/definition'
export type { FiberAttributes, FiberFourierMode, FiberHelix } from './elements/primitives/fiber/definition'
export type { SphereAttributes } from './elements/primitives/sphere/definition'
export type {
  CadDiagnostic,
  CadDiagnosticPhase,
  CadEvaluationRequest,
  CadEvaluationResponse,
  CadInspectionRequest,
  CadInspectionResponse,
  CadWorkerErrorType,
} from './worker/protocol'
