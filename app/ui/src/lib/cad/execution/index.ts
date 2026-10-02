export {
  CadDocumentEvaluationError,
  evaluateDocument,
  evaluateGeometryModule,
  inspectDocument,
} from './evaluateDocument'
export type {
  CadDocumentInspection,
  CatalogRuntimeSliceFetcher,
  EvaluateDocumentOptions,
  GeometryModuleEvaluationOptions,
  GeometryModulePreview,
} from './evaluateDocument'
export { serializeEvaluatedDocumentSnapshot } from './snapshot'
export type {
  EvaluatedDocumentSnapshot,
  EvaluatedExperimentSnapshot,
  EvaluatedRuntimeDocumentSnapshot,
  MeasurementExperimentSnapshot,
} from './snapshot'
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
