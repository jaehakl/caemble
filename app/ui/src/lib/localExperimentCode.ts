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

const starterGeometryCode = `import { Box, type Geometry, type Vec3 } from '@caemble/core'

export const StarterStructure: Geometry<{ size: Vec3 }> = ({ size = [36, 24, 12] }) => (
  <Box size={size} />
)
`

export const draftTaskCode = `import { defineTask } from '@caemble/core'

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
  'tasks/main.tsx': draftTaskCode,
})
