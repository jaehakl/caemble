import { createExperimentSourceBundle } from './cad'
import { DRAFT_TASK_KERNEL } from './catalog/draftTask'

const starterExperimentCode = `import { experiment } from '@caemble/core'
import { StarterStructure } from './geometry'
import { StarterMaterial } from './material'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    size: { min: [36, 24, 12], max: [36, 24, 12] },
  },
  geometry: ({ vars }) => (
    <StarterStructure id="starter" size={vars.size} materials={{ body: StarterMaterial }} />
  ),
  recordedData: {},
})
`

const starterMaterialCode = `import { Material } from '@caemble/core'

export const StarterMaterial = new Material('Starter Material')
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

const blankMaterialCode = `export {}
`

const placeholderTaskCode = `import { defineTask } from '@caemble/core'

// Draft preview only: select a compatible Solver and config before creating a Measurement or running CAE.
export default defineTask({
  kernel: { name: '${DRAFT_TASK_KERNEL.name}', version: '${DRAFT_TASK_KERNEL.version}' },
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
  'material.tsx': starterMaterialCode,
  'simulate.py': placeholderSimulationCode,
  'tasks/main.tsx': placeholderTaskCode,
})

export const blankExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': blankExperimentCode,
  'geometry.tsx': blankGeometryCode,
  'material.tsx': blankMaterialCode,
  'simulate.py': placeholderSimulationCode,
  'tasks/main.tsx': placeholderTaskCode,
})
