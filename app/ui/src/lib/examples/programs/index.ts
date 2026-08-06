import { dcNotchedCurrentDensityExample } from './dcNotchedCurrentDensity'
import { dcResolutionStudyExample } from './dcResolutionStudy'
import { dcUniformBarExample } from './dcUniformBar'
import { electroThermalUniformBarExample } from './electroThermalUniformBar'

export type { CaembleProgramExample } from './types'
export {
  dcNotchedCurrentDensityExample,
  dcNotchedCurrentDensityExperimentCode,
  dcNotchedCurrentDensitySimulationCode,
  dcNotchedCurrentDensityStructureCode,
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
  dcUniformBarStructureCode,
} from './dcUniformBar'
export {
  electroThermalUniformBarExample,
  electroThermalUniformBarExperimentCode,
  electroThermalUniformBarSimulationCode,
  electroThermalUniformBarStructureCode,
} from './electroThermalUniformBar'

export const CAEMBLE_PROGRAM_EXAMPLE_SEED = 20_260_803

export const caembleProgramExamples = Object.freeze([
  dcUniformBarExample,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  electroThermalUniformBarExample,
])
