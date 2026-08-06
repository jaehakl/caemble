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
export { experiment, ExperimentDefinition, structure, StructureDefinition } from './model/v3'
export type {
  CadDefinition,
  ExperimentDefinitionOptions,
  ExternalVars,
  InferVars,
  ModelContext,
  StructureDefinitionOptions,
  VarsSchemaDefinition,
} from './model/v3'
export { assertUcumUnitComparable, convertUcumValue, normalizeUcumUnit } from './model/units'
export { normalizeDataValueDescriptor } from './model/core'
export type {
  CartesianBasis,
  DataAxis,
  DataDType,
  DataValueDescriptor,
  FloatDataDType,
  ExperimentParameter,
  ExperimentParameters,
  ExperimentTarget,
  Geometry,
  GeometryAttributes,
  IntegerDataDType,
  MaterialDataValueDescriptor,
  MaterialQuantitySeries,
  MaterialSampledRelation,
  MaterialVariable,
  MaterialVariables,
  MatrixValue,
  NonFloatDataDType,
  NormalizedMaterialVariables,
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
  StructureGroupMap,
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
  assertCadSourceDocument,
  cadSource,
  cadSourceHash,
  createCadSourceDocument,
  createRealizationSeed,
  rerollCadSourceDocument,
  updateCadSource,
} from './source/document'
export type { CadDocumentType, CadEvaluationInput, CadSourceDocument } from './source/document'
export { CadDocumentEvaluationError, evaluateDocument } from './execution/evaluateDocument'
export type { EvaluateDocumentOptions } from './execution/evaluateDocument'
export { assertEvaluatedDocumentSnapshot, serializeEvaluatedDocumentSnapshot } from './execution/snapshot'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedRuntimeDocumentSnapshot,
  EvaluatedStructureSnapshot,
} from './execution/snapshot'
export {
  applyFrozenMaterialParameters,
  assertBuiltRealization,
  buildRealization,
  buildSourceOnlyRealization,
} from './execution/realization'
export type { BuiltRealization, BuiltSample, BuiltSetup } from './execution/realization'
export { assertSerializableCadScene, deserializeCadScene, serializeCadScene } from './execution/mesh'
export type { SerializableCadMesh, SerializableCadScene, SerializableCadScenePart } from './execution/mesh'
export { normalizeRecordedData, normalizeRecordedDataTensor } from './model/recordedData'
export type { ResolvedRecordedTensor } from './model/recordedData'
export { CadCompilationError, compileCadDocument } from './compiler/monacoCompiler'
export type { CadDiagnostic as CompilerDiagnostic, CompiledCadSource } from './compiler/types'
export { cadSemanticHash, compiledCadSemanticHash, rawCodeHash } from './compiler/semanticHash'
export {
  evaluateInIsolatedRunner,
  preflightSimulationInIsolatedRunner,
  runSimulationInIsolatedRunner,
} from './runner/client'
export type {
  SimulationPreflightIssue,
  SimulationPreflightRequest,
  SimulationPreflightResponse,
  SimulationRunRequest,
  SimulationRunResponse,
} from './runner/protocol'
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
  CadWorkerErrorType,
} from './worker/protocol'
