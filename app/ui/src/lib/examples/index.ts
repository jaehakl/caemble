import { defaultCode } from '../defaultCode'
import { fiberBundleCode } from './fiberBundle'
import { shellCutawaysCode } from './shellCutaways'
import { curvedEdgeCylinderArrayCode } from './curvedEdgeCylinderArray'
import { curvedSurfaceSphereHcpArrayCode } from './curvedSurfaceSphereHcpArray'
import { basketballGoalExample } from './basketballGoal'

export {
  caembleProgramExamples,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  dcUniformBarExample,
} from './programs'
export type { CaembleProgramExample } from './programs'
export { basketballGoalCode, basketballGoalExample } from './basketballGoal'
export {
  wheelAssemblyExample,
  wheelAssemblyExperimentCode,
  wheelAssemblyGeometryCode,
  wheelAssemblyMaterialCode,
  wheelAssemblySourceBundle,
  wheelAssemblyTaskCode,
} from './wheelAssembly'

export type CaembleExample = Readonly<{
  id: string
  title: string
  description: string
  code: string
  mode: 'simulation' | 'geometry-preview'
}>

export const caembleExamples: readonly CaembleExample[] = Object.freeze([
  basketballGoalExample,
  {
    id: 'dc-conductor',
    title: 'DC Conductor',
    description: 'An eccentric notched copper bar for the default 3D DC current-density heatmap solver.',
    code: defaultCode,
    mode: 'simulation',
  },
  {
    id: 'fiber-bundle',
    title: 'Fiber Bundle',
    description:
      'Geometry-only Experiment preview. Fourier modes and a curved path produce three tapered polymer fibers.',
    code: fiberBundleCode,
    mode: 'geometry-preview',
  },
  {
    id: 'shell-cutaways',
    title: 'Shell Cutaways',
    description:
      'Geometry-only Experiment preview. Role-offset maps create one, two, and three auto-colored shell layers.',
    code: shellCutawaysCode,
    mode: 'geometry-preview',
  },
  {
    id: 'random-curved-edge-cylinder-array',
    title: 'Random Curved Cylinder Array',
    description:
      'Geometry-only Experiment preview. A 4 × 4 array independently varies its Fourier and Taylor curves.',
    code: curvedEdgeCylinderArrayCode,
    mode: 'geometry-preview',
  },
  {
    id: 'random-curved-surface-sphere-hcp-array',
    title: 'Random Curved Sphere HCP Array',
    description:
      'Geometry-only Experiment preview. Variable curved spheres form a hexagonal close-packed lattice.',
    code: curvedSurfaceSphereHcpArrayCode,
    mode: 'geometry-preview',
  },
])
