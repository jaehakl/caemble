export {
  insertPrimitiveAfterCursorLine,
  operationAuthoringElements,
  primitiveAuthoringElements,
  wrapSelectionWithOperation,
  type CadAuthoringEditResult,
} from './authoringEdits'
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
} from './document'
export type {
  CadDocumentType,
  CadEvaluationInput,
  CadSourceDocument,
  ExperimentSourceBundle,
  ExperimentSourceDocument,
} from './document'
export {
  analyzeBundleModuleSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  assertExperimentModuleGraph,
  geometryExportAtOffset,
  projectGeometryExportSource,
} from './sourceAnalysis'
export {
  assertExperimentSourcePath,
  assertExperimentSourcePaths,
  experimentTypeScriptPaths,
  isExperimentTypeScriptPath,
  resolveExperimentModuleSpecifier,
} from './moduleResolution'
