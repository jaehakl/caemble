import { createExperimentSourceBundle } from './cad'

const starterExperimentCode = `import { experiment } from '@caemble/core'
import { StarterStructure } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    size: { min: [36, 24, 12], max: [36, 24, 12] },
  },
  geometry: ({ vars }) => <StarterStructure id="starter" size={vars.size} />,
  recordedData: {},
})
`

const starterGeometryCode = `import { type Geometry, type Vec3 } from '@caemble/core'

export const StarterStructure: Geometry<{ size: Vec3 }> = ({ size }) => (
  <box size={size} />
)
`

const blankExperimentCode = `import { experiment } from '@caemble/core'
import { EmptyStructure } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => <EmptyStructure id="structure" />,
  recordedData: {},
})
`

const blankGeometryCode = `import { type Geometry } from '@caemble/core'

export const EmptyStructure: Geometry = () => <></>
`

const placeholderTaskCode = `import { defineTask } from '@caemble/core'

// Replace this placeholder kernel and config before running the Experiment.
export default defineTask({
  kernel: { name: 'replace-with-solver', version: '1.0.0' },
  config: () => ({}),
})
`

const placeholderSimulationCode = `async def simulate(*, sim, tasks, vars):
    # Replace this no-op body after configuring tasks/main.tsx.
    return None
`

export const starterExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': starterExperimentCode,
  'geometry.tsx': starterGeometryCode,
  'simulate.py': placeholderSimulationCode,
  'tasks/main.tsx': placeholderTaskCode,
})

export const blankExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': blankExperimentCode,
  'geometry.tsx': blankGeometryCode,
  'simulate.py': placeholderSimulationCode,
  'tasks/main.tsx': placeholderTaskCode,
})
