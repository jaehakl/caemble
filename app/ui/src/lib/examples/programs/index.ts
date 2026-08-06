import { dcNotchedCurrentDensityExample } from './dcNotchedCurrentDensity'
import { dcResolutionStudyExample } from './dcResolutionStudy'
import { dcUniformBarExample } from './dcUniformBar'
import { electroThermalUniformBarExample } from './electroThermalUniformBar'

export type { CaembleProgramExample } from './types'
export {
  dcNotchedCurrentDensityExample,
  dcNotchedCurrentDensityExperimentCode,
  dcNotchedCurrentDensityStructureCode,
} from './dcNotchedCurrentDensity'
export { dcResolutionStudyExample, dcResolutionStudyExperimentCode } from './dcResolutionStudy'
export { dcUniformBarExample, dcUniformBarExperimentCode, dcUniformBarStructureCode } from './dcUniformBar'
export {
  electroThermalUniformBarExample,
  electroThermalUniformBarExperimentCode,
  electroThermalUniformBarStructureCode,
} from './electroThermalUniformBar'

export const CAEMBLE_PROGRAM_EXAMPLE_SEED = 20_260_803

export const caembleProgramExamples = Object.freeze([
  dcUniformBarExample,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  electroThermalUniformBarExample,
])
