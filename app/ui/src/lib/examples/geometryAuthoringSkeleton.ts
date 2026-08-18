import { createExperimentSourceBundle } from '../cad/source/document'

export const geometryAuthoringSkeletonCode = `import { type Geometry } from '@caemble/core'

export const Assembly: Geometry = () => (
  <>
    <box id="base" size={[100, 60, 10]} position={[0, 0, 5]} />
    <cylinder id="post" radius={5} height={80} position={[0, 0, 50]} />
  </>
)
`

export const geometryAuthoringSkeletonSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': `import { experiment } from '@caemble/core'
import { Assembly } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {},
  geometry: () => <Assembly id="assembly" />,
  recordedData: {},
})
`,
  'geometry.tsx': geometryAuthoringSkeletonCode,
  'material.tsx': 'export {}\n',
  'simulate.py': 'async def simulate(*, sim, tasks, vars):\n    return None\n',
  'tasks/preview.tsx': `import { defineTask } from '@caemble/core'
export default defineTask({ kernel: { name: 'geometry-authoring-preview', version: '1.0.0' }, config: () => ({}) })
`,
})
