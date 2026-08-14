import { createExperimentSourceBundle } from './cad'
import {
  defaultExperimentGeometryCode,
  defaultExperimentMaterialCode,
  defaultExperimentProgramCode,
  defaultExperimentTaskCode,
} from './defaultExperimentProgramCode'
import { defaultExperimentSimulationCode } from './defaultExperimentSimulationCode'

export const defaultExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': defaultExperimentProgramCode,
  'geometry.tsx': defaultExperimentGeometryCode,
  'material.tsx': defaultExperimentMaterialCode,
  'simulate.py': defaultExperimentSimulationCode,
  'tasks/electric.tsx': defaultExperimentTaskCode,
})

export { defaultExperimentProgramCode as defaultExperimentCode } from './defaultExperimentProgramCode'
