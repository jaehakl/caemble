import { createExperimentSourceBundle } from '../cad/source/document'
import { DRAFT_TASK_KERNEL } from '../catalog/draftTask'

export const wheelAssemblyMaterialCode = `import { Material } from '@caemble/core'

export const Rubber = new Material('Rubber', { errorRate: 0 })
export const Aluminum = new Material('Aluminum', { errorRate: 0 })
`

export const wheelAssemblyGeometryCode = `import { type Geometry } from '@caemble/core'

const Tire: Geometry<{
  height: number
  innerRadius: number
  outerRadius: number
}> = ({ height, innerRadius, outerRadius }) => (
  <subtract>
    <cylinder height={height} radius={outerRadius} />
    <cylinder height={height * 1.1} radius={innerRadius} />
  </subtract>
)

const Hub: Geometry<{
  height: number
  radius: number
}> = ({ height, radius }) => <cylinder height={height} radius={radius} />

const WheelParts: Geometry<{
  height: number
  hubRadius: number
  tireInnerRadius: number
  tireOuterRadius: number
}> = ({ height, hubRadius, materials, tireInnerRadius, tireOuterRadius }) => (
  <>
    <Tire
      id="tire"
      height={height}
      innerRadius={tireInnerRadius}
      outerRadius={tireOuterRadius}
      materials={{ body: materials?.tire }}
    />
    <Hub
      id="hub"
      height={height}
      radius={hubRadius}
      materials={{ body: materials?.wheel }}
    />
  </>
)

export const WheelAssembly: Geometry<{
  height: number
  hubRadius: number
  tireInnerRadius: number
  tireOuterRadius: number
}> = ({ height, hubRadius, tireInnerRadius, tireOuterRadius }) => (
  <WheelParts
    id="parts"
    height={height}
    hubRadius={hubRadius}
    tireInnerRadius={tireInnerRadius}
    tireOuterRadius={tireOuterRadius}
  />
)
`

export const wheelAssemblyExperimentCode = `import { experiment } from '@caemble/core'
import { WheelAssembly } from './geometry'
import { Aluminum, Rubber } from './material'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => (
    <WheelAssembly
      id="wheel"
      height={12}
      hubRadius={8}
      tireInnerRadius={10}
      tireOuterRadius={16}
      materials={{ tire: Rubber, wheel: Aluminum }}
    />
  ),
  recordedData: {},
})
`

export const wheelAssemblyTaskCode = `import { defineTask } from '@caemble/core'
import { WheelAssembly } from '../geometry'
import { Aluminum, Rubber } from '../material'

export default defineTask({
  kernel: { name: '${DRAFT_TASK_KERNEL.name}', version: '${DRAFT_TASK_KERNEL.version}' },
  lengthUnit: 'mm',
  geometry: () => (
    <WheelAssembly
      id="wheel-preview"
      height={12}
      hubRadius={8}
      tireInnerRadius={10}
      tireOuterRadius={16}
      materials={{ tire: Rubber, wheel: Aluminum }}
    />
  ),
  config: () => ({}),
})
`

const wheelAssemblySimulationCode = `async def simulate(*, sim, tasks, vars):
    # Select a compatible solver before running this authoring example.
    return None
`

export const wheelAssemblySourceBundle = createExperimentSourceBundle({
  'experiment.tsx': wheelAssemblyExperimentCode,
  'geometry.tsx': wheelAssemblyGeometryCode,
  'material.tsx': wheelAssemblyMaterialCode,
  'simulate.py': wheelAssemblySimulationCode,
  'tasks/main.tsx': wheelAssemblyTaskCode,
})

export const wheelAssemblyExample = Object.freeze({
  id: 'two-material-wheel-assembly',
  title: 'Two-material Wheel Assembly',
  description: 'Solver 미선택 Draft preview로 tire/wheel 역할 전달, body remap, Material 자동색을 보여줍니다.',
  concepts: Object.freeze(['material.tsx', 'role map 상속', 'body remap', 'role hash 자동색']),
  experimentSourceBundle: wheelAssemblySourceBundle,
})
