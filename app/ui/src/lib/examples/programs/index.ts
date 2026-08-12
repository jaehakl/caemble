import { dcNotchedCurrentDensityExample } from './dcNotchedCurrentDensity'
import { dcResolutionStudyExample } from './dcResolutionStudy'
import { dcUniformBarExample } from './dcUniformBar'
import { electroThermalUniformBarExample } from './electroThermalUniformBar'

export type { CaembleProgramExample } from './types'
export {
  dcNotchedCurrentDensityExample,
  dcNotchedCurrentDensityExperimentCode,
  dcNotchedCurrentDensitySimulationCode,
} from './dcNotchedCurrentDensity'
export {
  dcResolutionStudyExample,
  dcResolutionStudyExperimentCode,
  dcResolutionStudySimulationCode,
} from './dcResolutionStudy'
export {
  dcUniformBarExample,
  dcUniformBarExperimentCode,
  dcUniformBarSimulationCode,
} from './dcUniformBar'
export {
  electroThermalUniformBarExample,
  electroThermalUniformBarExperimentCode,
  electroThermalUniformBarSimulationCode,
} from './electroThermalUniformBar'

export const caembleProgramExamples = Object.freeze([
  dcUniformBarExample,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  electroThermalUniformBarExample,
])
