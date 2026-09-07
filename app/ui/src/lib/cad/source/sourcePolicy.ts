import {
  EXPERIMENT_ENTRY_PATH,
  EXPERIMENT_GEOMETRY_PATH,
  EXPERIMENT_MATERIAL_PATH,
  experimentTaskName,
} from './document'
import {
  analyzeBundleModuleSource,
  analyzeCadSource,
  analyzeGeometrySource,
  analyzeMaterialSource,
  analyzeTaskSource,
} from './sourceAnalysis'

export function assertCadSourcePolicy(path: string, source: string) {
  if (path === EXPERIMENT_ENTRY_PATH) analyzeCadSource(source)
  else if (path === EXPERIMENT_GEOMETRY_PATH) analyzeGeometrySource(source, { allowEmpty: true })
  else if (path === EXPERIMENT_MATERIAL_PATH) analyzeMaterialSource(source)
  else if (experimentTaskName(path) !== null) analyzeTaskSource(source)
  else analyzeBundleModuleSource(source, path)
}
