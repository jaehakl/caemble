export { evaluateCad, evaluateCadScene } from './evaluation/evaluator'
export { cadAuthoringContract, cadElementCatalog } from './catalog'
export { CAD_API_DECLARATION_FINGERPRINT } from './api/generatedVersions'
export {
  insertPrimitiveAfterCursorLine,
  operationAuthoringElements,
  primitiveAuthoringElements,
  wrapSelectionWithOperation,
  type CadAuthoringEditResult,
} from './source/authoringEdits'
export { applyCadSceneGroups } from './evaluation/groups'
export { Fragment, h } from './evaluation/jsx'
export type {
  CadScene,
  CadSceneGroup,
  CadSceneMaterial,
  CadScenePart,
  CadSceneSurface,
  CadSceneTreeNode,
  CadAuthoringContract,
  CadElementChildrenManifest,
  CadElementManifest,
  CadElementPropertyManifest,
} from './evaluation/types'
export { MAX_CANONICAL_GEOMETRY_TRIANGLES } from './evaluation/canonicalTypes'
export type {
  CanonicalAffineMatrixV1,
  CanonicalBooleanNodeV1,
  CanonicalFiberNodeV1,
  CanonicalGeometryGroupV1,
  CanonicalGeometryMaterialV1,
  CanonicalGeometryNodeV1,
  CanonicalGeometryRootV1,
  CanonicalGeometrySceneV1,
  CanonicalInstanceNodeV1,
  CanonicalPrimitiveNameV1,
  CanonicalPrimitiveNodeV1,
  CanonicalShellNodeV1,
  CanonicalSurfaceGroupV1,
  CanonicalSurfaceSelectorV1,
  CanonicalTransformNodeV1,
  CanonicalVec3V1,
} from './evaluation/canonicalTypes'
export { CadModelError, isFloatDType, Mat, Material, radians } from './model/core'
export { defineTask, experiment, ExperimentDefinition, TaskDefinition } from './model/v5'
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
export { generateRandomVars, normalizeVars, normalizeVarsSchema, varsSchemaFingerprint } from './model/vars'
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
  CanonicalGeometryTransformAttributes,
  Geometry,
  GeometryAttributes,
  GeometryIdentityAttributes,
  GeometryInvocationAttributes,
  GeometryTransformAttributes,
  IntegerDataDType,
  IntrinsicGeometryAttributes,
  LegacyRecordedDataTensor,
  LegacyGeometryTransformAttributes,
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
  GeometrySurfaceRef,
  SurfaceGroupMap,
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
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  EXPERIMENT_SIMULATION_PATH,
  EXPERIMENT_SOURCE_BUNDLE_FORMAT_VERSION,
  addExperimentSourceFile,
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
  removeExperimentSourceFile,
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
export {
  analyzeBundleModuleSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  assertExperimentModuleGraph,
  geometryExportAtOffset,
  projectGeometryExportSource,
} from './source/sourceAnalysis'
export {
  assertExperimentSourcePath,
  assertExperimentSourcePaths,
  experimentTypeScriptPaths,
  isExperimentTypeScriptPath,
  resolveExperimentModuleSpecifier,
} from './source/moduleResolution'
export {
  CadDocumentEvaluationError,
  evaluateDocument,
  evaluateGeometryModule,
  inspectDocument,
} from './execution/evaluateDocument'
export type {
  CadDocumentInspection,
  EvaluateDocumentOptions,
  GeometryModuleEvaluationOptions,
  GeometryModulePreview,
} from './execution/evaluateDocument'
export { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './execution/snapshot'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedRuntimeDocumentSnapshot,
  MeasurementExperimentSnapshot,
} from './execution/snapshot'
export {
  applyFrozenMaterialParameters,
  assertBuiltMeasurement,
  buildMeasurement,
  buildSourceOnlyMeasurement,
  unresolvedMeasurementMaterialRoles,
} from './execution/measurement'
export type { BuiltMeasurement, MeasurementMaterialResolution, TaskMaterialResolution } from './execution/measurement'
export { assertSerializableCadScene, deserializeCadScene, serializeCadScene } from './execution/mesh'
export type { SerializableCadMesh, SerializableCadScene, SerializableCadScenePart } from './execution/mesh'
export { normalizeRecordedData, normalizeRecordedDataTensor } from './model/recordedData'
export {
  isRayPathRecordedDataName,
  parseRayPathBundles,
  RAY_PATH_EVENT_NAMES,
  type RayPathBundle,
  type RayPathEventName,
} from './model/rayPaths'
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
export type { CompileCadDocumentOptions } from './compiler/monacoCompiler'
export type { CadDiagnostic as CompilerDiagnostic, CompiledCadDocument, CompiledCadSource } from './compiler/types'
export {
  cadSemanticHash,
  compiledCadDocumentSemanticHash,
  compiledCadSemanticHash,
  rawCodeHash,
} from './compiler/semanticHash'
export { evaluateInIsolatedRunner, inspectInIsolatedRunner, previewGeometryInIsolatedRunner } from './runner/client'
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
  CadGeometryPreviewRequest,
  CadGeometryPreviewResponse,
  CadWorkerErrorType,
} from './worker/protocol'
