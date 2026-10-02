export { evaluateCad, evaluateCadScene } from '@caemble/execution/cad/evaluation/evaluator'
export { cadAuthoringContract, cadElementCatalog } from '@caemble/execution/cad/catalog'
export {
  insertPrimitiveAfterCursorLine,
  operationAuthoringElements,
  primitiveAuthoringElements,
  wrapSelectionWithOperation,
  type CadAuthoringEditResult,
} from '@caemble/execution/cad/source/authoringEdits'
export { applyCadSceneGroups } from '@caemble/execution/cad/evaluation/groups'
export { Fragment, h } from '@caemble/execution/cad/evaluation/jsx'
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
  CadElementSurfaceManifest,
} from '@caemble/execution/cad/evaluation/types'
export type {
  CanonicalAffineMatrixV2,
  CanonicalBooleanNodeV2,
  CanonicalFiberNodeV2,
  CanonicalGeometryGroupV2,
  CanonicalGeometryMaterialV2,
  CanonicalGeometryNodeV2,
  CanonicalGeometryRootV2,
  CanonicalGeometrySceneV2,
  CanonicalInstanceNodeV2,
  CanonicalPrimitiveNameV2,
  CanonicalPrimitiveNodeV2,
  CanonicalSurfaceGroupV2,
  CanonicalSurfaceSelectorV2,
  CanonicalTransformNodeV2,
  CanonicalVec3V2,
} from '@caemble/execution/cad/evaluation/canonicalTypes'
export {
  CadModelError,
  isFloatDType,
  Mat,
  Material,
  MaterialInteraction,
  radians,
} from '@caemble/execution/cad/model/core'
export { defineTask, experiment, ExperimentDefinition, TaskDefinition } from '@caemble/execution/cad/model/definition'
export type {
  CadDefinition,
  ExperimentDefinitionOptions,
  ExternalVars,
  InferVars,
  ModelContext,
  TaskDefinitionOptions,
  TaskModelContext,
  VarsSchemaDefinition,
} from '@caemble/execution/cad/model/definition'
export {
  generateRandomVars,
  normalizeVars,
  normalizeVarsSchema,
  varsFingerprint,
  varsSchemaFingerprint,
} from '@caemble/execution/cad/model/vars'
export { convertUcumValue, normalizeUcumUnit } from '@caemble/execution/cad/model/units'
export { normalizeDataValueDescriptor } from '@caemble/execution/cad/model/core'
export type {
  CartesianBasis,
  DataAxis,
  DataDType,
  Complex64Value,
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
  DataTensorInput,
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
  GeometryGroupMap,
  GeometrySurfaceRef,
  SurfaceGroupMap,
  TensorQuantityKindName,
  VarsSchemaEntry,
} from '@caemble/execution/cad/model/core'
export type { UcumUnit } from '@caemble/execution/cad/model/units'
export type { Rotation, Tensor, Vars, Vec3 } from '@caemble/execution/cad/model/types'
export { createSolidPointTester } from '@caemble/execution/cad/geometry/solid'
export type { SolidPointTester } from '@caemble/execution/cad/geometry/solid'
export type {
  MaterialDefinition,
  MaterialModelInstance,
  MaterialSnapshot,
  TaskMaterialSelections,
} from '@caemble/execution/contracts/material'
export {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  EXPERIMENT_SIMULATION_PATH,
  addExperimentSourceFile,
  addExperimentTask,
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
} from '@caemble/execution/cad/source/document'
export type {
  CadDocumentType,
  CadEvaluationInput,
  CadSourceDocument,
  ExperimentSourceBundle,
  ExperimentSourceDocument,
} from '@caemble/execution/cad/source/document'
export {
  analyzeGeometrySource,
  analyzeMaterialSource,
  assertExperimentModuleGraph,
  geometryExportAtOffset,
  projectGeometryExportSource,
} from '@caemble/execution/cad/source/sourceAnalysis'
export {
  assertExperimentSourcePath,
  assertExperimentSourcePaths,
  experimentTypeScriptPaths,
  isExperimentTypeScriptPath,
  resolveExperimentModuleSpecifier,
} from '@caemble/execution/cad/source/moduleResolution'
export {
  CadDocumentEvaluationError,
  evaluateDocument,
  evaluateGeometryModule,
  inspectDocument,
} from './execution/evaluateDocument'
export type {
  CadDocumentInspection,
  CatalogRuntimeSliceFetcher,
  EvaluateDocumentOptions,
  GeometryModuleEvaluationOptions,
  GeometryModulePreview,
} from './execution/evaluateDocument'
export { serializeEvaluatedDocumentSnapshot } from './execution/snapshot'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedRuntimeDocumentSnapshot,
  MeasurementExperimentSnapshot,
} from './execution/snapshot'
export { applyMaterialSnapshot, buildMeasurement } from '@caemble/execution/cad/execution/measurement'
export type {
  BuiltMeasurement,
  MeasurementMaterialResolution,
  TaskMaterialResolution,
} from '@caemble/execution/cad/execution/measurement'
export { deserializeCadScene, serializeCadScene } from '@caemble/execution/cad/execution/mesh'
export type {
  SerializableCadMesh,
  SerializableCadScene,
  SerializableCadScenePart,
} from '@caemble/execution/cad/execution/mesh'
export { normalizeRecordedData, normalizeRecordedDataTensor } from '@caemble/execution/cad/model/recordedData'
export { type PolylineBundle } from '@caemble/execution/cad/model/rayPaths'
export type {
  RecordedDataSchemaTree,
  RecordedDataSpecGroup,
  RecordedDataSpecNode,
  ResolvedDataSchema,
  ResolvedDataSchemaGroup,
  ResolvedDataSchemaNode,
  SimulationProgramManifest,
} from '@caemble/execution/cad/simulation/types'
export type { ResolvedRecordedTensor } from '@caemble/execution/cad/model/recordedData'
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
} from '@caemble/execution/cad/model/dataTensor'
export type { DataTensorAccessor } from '@caemble/execution/cad/model/dataTensor'
export { CadCompilationError, compileCadDocument } from './compiler/monacoCompiler'
export type { CompileCadDocumentOptions } from './compiler/monacoCompiler'
export type {
  CadDiagnostic as CompilerDiagnostic,
  CompiledCadDocument,
  CompiledCadSource,
} from '@caemble/execution/cad/compiler/types'
export {
  cadSemanticHash,
  compiledCadDocumentSemanticHash,
  compiledCadSemanticHash,
  rawCodeHash,
} from './compiler/semanticHash'
export {
  evaluateInIsolatedRunner,
  inspectInIsolatedRunner,
  previewGeometryInIsolatedRunner,
} from '@/platform/isolated-runner/client'
export type { ArrayAttributes } from '@caemble/execution/cad/elements/operations/array/definition'
export type { BooleanAttributes } from '@caemble/execution/cad/elements/operations/booleans/definition'
export type { BoxAttributes } from '@caemble/execution/cad/elements/primitives/box/definition'
export type { CylinderAttributes } from '@caemble/execution/cad/elements/primitives/cylinder/definition'
export type {
  CurvedEdgeCylinderAttributes,
  CurvedEdgeCylinderFourierMode,
  CurvedEdgeCylinderTaylorCurve,
} from '@caemble/execution/cad/elements/primitives/curvedEdgeCylinder/definition'
export type {
  FiberAttributes,
  FiberPath,
  FiberSegment,
  RadiusKnot,
} from '@caemble/execution/cad/elements/primitives/fiber/definition'
export type { SphereAttributes } from '@caemble/execution/cad/elements/primitives/sphere/definition'
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
} from '@caemble/execution/cad/worker/protocol'

export type { AsphericCylinderAttributes } from '@caemble/execution/cad/elements/primitives/asphericCylinder/definition'
export type { EllipsoidAttributes } from '@caemble/execution/cad/elements/primitives/ellipsoid/definition'
export type { HyperboloidAttributes } from '@caemble/execution/cad/elements/primitives/hyperboloid/definition'
export type { ParaboloidAttributes } from '@caemble/execution/cad/elements/primitives/paraboloid/definition'
export type { Tessellation, Asphere } from '@caemble/execution/cad/geometry/continuous'
