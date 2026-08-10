import { createExperimentSourceBundle } from './cad'
import { defaultExperimentProgramCode, defaultExperimentTaskCode } from './defaultExperimentProgramCode'
import { defaultExperimentSimulationCode } from './defaultExperimentSimulationCode'

export const defaultExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': defaultExperimentProgramCode,
  'simulate.py': defaultExperimentSimulationCode,
  'tasks/electric.tsx': defaultExperimentTaskCode,
})

export { defaultExperimentProgramCode as defaultExperimentCode } from './defaultExperimentProgramCode'
