import { createExperimentSourceBundle } from '../cad/source/document'

export const geometryAuthoringSkeletonCode = `import { Box, Cylinder, type Geometry } from '@caemble/core'

export const Assembly: Geometry<{ includeBraces?: boolean }> = ({ includeBraces = true }) => {
  const braces: unknown[] = []
  if (includeBraces) {
    for (let index = 0; index < 2; index += 1) {
      braces.push(
        <Box id={\`brace-\${index}\`} size={[4, 40, 4]} position={[index === 0 ? -20 : 20, 0, 30]} />,
      )
    }
  }

  return (
    <>
      <Box id="base" size={[100, 60, 10]} position={[0, 0, 5]} />
      <Cylinder id="post" radius={5} height={80} position={[0, 0, 50]} />
      {braces}
    </>
  )
}
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
