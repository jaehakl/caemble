import { defaultCode } from '../defaultCode'
import { fiberBundleCode } from './fiberBundle'
import { shellCutawaysCode } from './shellCutaways'
import { curvedEdgeCylinderArrayCode } from './curvedEdgeCylinderArray'
import { curvedSurfaceSphereHcpArrayCode } from './curvedSurfaceSphereHcpArray'

export {
  CAEMBLE_PROGRAM_EXAMPLE_SEED,
  caembleProgramExamples,
  dcNotchedCurrentDensityExample,
  dcResolutionStudyExample,
  dcUniformBarExample,
} from './programs'
export type { CaembleProgramExample } from './programs'

export type CaembleExample = Readonly<{
  id: string
  title: string
  description: string
  code: string
  mode: 'simulation' | 'geometry-preview'
}>

export const caembleExamples: readonly CaembleExample[] = Object.freeze([
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
      'Geometry preview with the default DC Experiment; simulation requires a matching Experiment. Fourier modes and a curved path produce three tapered polymer fibers.',
    code: fiberBundleCode,
    mode: 'geometry-preview',
  },
  {
    id: 'shell-cutaways',
    title: 'Shell Cutaways',
    description:
      'Geometry preview with the default DC Experiment; simulation requires a matching Experiment. One, two, and three colored shell layers use cutaway procedural geometries.',
    code: shellCutawaysCode,
    mode: 'geometry-preview',
  },
  {
    id: 'random-curved-edge-cylinder-array',
    title: 'Random Curved Cylinder Array',
    description:
      'Geometry preview with the default DC Experiment; simulation requires a matching Experiment. A 4 × 4 array independently randomizes its Fourier and Taylor curves.',
    code: curvedEdgeCylinderArrayCode,
    mode: 'geometry-preview',
  },
  {
    id: 'random-curved-surface-sphere-hcp-array',
    title: 'Random Curved Sphere HCP Array',
    description:
      'Geometry preview with the default DC Experiment; simulation requires a matching Experiment. Random curved spheres form a hexagonal close-packed lattice.',
    code: curvedSurfaceSphereHcpArrayCode,
    mode: 'geometry-preview',
  },
])
