import { dcNotchedCurrentDensityExample } from './dcNotchedCurrentDensity'
import { dcResolutionStudyExample } from './dcResolutionStudy'
import { dcUniformBarExample } from './dcUniformBar'
import { electroThermalUniformBarExample } from './electroThermalUniformBar'

export type { CaembleProgramExample } from './types'
export {
  dcNotchedCurrentDensityExample,
  dcNotchedCurrentDensityExperimentCode,
  dcNotchedCurrentDensityMaterialCode,
  dcNotchedCurrentDensitySimulationCode,
} from './dcNotchedCurrentDensity'
export {
  dcResolutionStudyExample,
  dcResolutionStudyExperimentCode,
  dcResolutionStudyMaterialCode,
  dcResolutionStudySimulationCode,
} from './dcResolutionStudy'
export {
  dcUniformBarExample,
  dcUniformBarExperimentCode,
  dcUniformBarMaterialCode,
  dcUniformBarSimulationCode,
} from './dcUniformBar'
export {
  electroThermalUniformBarExample,
  electroThermalUniformBarExperimentCode,
  electroThermalUniformBarMaterialCode,
  electroThermalUniformBarSimulationCode,
} from './electroThermalUniformBar'

export const caembleProgramExamples = Object.freeze([
  dcUniformBarExample,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  electroThermalUniformBarExample,
])
