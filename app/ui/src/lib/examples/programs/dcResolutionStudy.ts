import { createExperimentSourceBundle } from '../../cad/source/document'
import type { CaembleProgramExample } from './types'

export const dcResolutionStudyExperimentCode = `import { experiment } from '@caemble/core'
import { Conductor } from './geometry'
import { Copper } from './material'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    conductorSize: { min: [100, 5, 5], max: [100, 5, 5] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
    sourceVoltage: { min: 1, max: 1 },
  },
  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.conductorSize}
      materials={{ body: Copper(vars.electricalConductivity as number) }}
    />
  ),
  geometryGroup: { conductor: ['conductor'] },
  surfaceGroup: {
    sourceTerminal: ['conductor/surface-1'],
    referenceTerminal: ['conductor/surface-2'],
  },
  recordedData: {
    coarseTotalCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
    fineTotalCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
})
`

export const dcResolutionStudyMaterialCode = `import { Mat, Material } from '@caemble/core'

export const Copper = (electricalConductivity: number) =>
  new Material('Copper', 'reference', {
    errorRate: 0,
    'electrical.conductivity': {
      dtype: 'float64',
      value: Mat(electricalConductivity),
      unit: 'S.m-1',
    },
    color: '#d97706',
  })
`

export const dcResolutionStudyGeometryCode = `import { type Geometry, type Vec3 } from '@caemble/core'

export const Conductor: Geometry<{ size: Vec3 }> = ({ size }) => <box size={size} />

export const ConvergenceProbe: Geometry = () => <box size={[2, 2, 2]} />
`

function resolutionTaskCode(gridShape: string, outputKey: string, probePosition: number) {
  return `import { defineTask } from '@caemble/core'
import { ConvergenceProbe } from '../geometry'
import { Copper } from '../material'

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.1.0' },
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <ConvergenceProbe
      id="convergence-probe"
      pos={[0, ${probePosition}, 0]}
      materials={{ body: Copper(vars.electricalConductivity as number) }}
    />
  ),
  config: ({ vars }) => ({
    parameters: {
      relativeTolerance: {
        dtype: 'float64',
        value: 1e-10,
        unit: '{fraction}',
        quantityKind: 'DimensionlessRatio',
      },
      maxIterations: 1000,
    },

    initializations: [
      {
        target: ['experiment.geometry.conductor'],
        methodId: 'dc.voxel-grid',
        parameters: {
          gridShape: {
            dtype: 'int32',
            axes: [{ length: 3 }],
            value: ${gridShape},
          },
        },
      },
    ],

    boundaryConditions: [
      {
        target: ['experiment.surface.sourceTerminal'],
        methodId: 'dc.source-potential',
        parameters: {
          voltage: {
            dtype: 'float64',
            value: vars.sourceVoltage,
            unit: 'mV',
            quantityKind: 'electromagnetism.Voltage',
          },
        },
      },
      {
        target: ['experiment.surface.referenceTerminal'],
        methodId: 'dc.reference-potential',
        parameters: {
          voltage: {
            dtype: 'float64',
            value: 0,
            unit: 'mV',
            quantityKind: 'electromagnetism.Voltage',
          },
        },
      },
    ],

    outputs: [
      {
        key: '${outputKey}',
        target: ['experiment.geometry.conductor'],
        methodId: 'dc.total-current',
        parameters: {
          crossSectionPosition: {
            dtype: 'float64',
            value: 0.5,
            unit: '{fraction}',
            quantityKind: 'DimensionlessRatio',
          },
        },
      },
    ],
  }),
})
`
}

export const dcResolutionStudyCoarseTaskCode = resolutionTaskCode('[10, 7, 7]', 'coarseTotalCurrent', -10)
export const dcResolutionStudyFineTaskCode = resolutionTaskCode('[20, 11, 11]', 'fineTotalCurrent', -14)

export const dcResolutionStudySimulationCode = `async def simulate(*, sim, tasks, vars):
    coarse = await sim.run(tasks["solveCoarse"])
    await sim.record(
        "coarseTotalCurrent",
        coarse["artifacts"]["coarseTotalCurrent"],
    )
    fine = await sim.run(tasks["solveFine"], state=coarse["state"])
    await sim.record(
        "fineTotalCurrent",
        fine["artifacts"]["fineTotalCurrent"],
    )
    return fine["state"]
`

export const dcResolutionStudyExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': dcResolutionStudyExperimentCode,
  'geometry.tsx': dcResolutionStudyGeometryCode,
  'material.tsx': dcResolutionStudyMaterialCode,
  'simulate.py': dcResolutionStudySimulationCode,
  'tasks/solveCoarse.tsx': dcResolutionStudyCoarseTaskCode,
  'tasks/solveFine.tsx': dcResolutionStudyFineTaskCode,
})

export const dcResolutionStudyExample = Object.freeze({
  id: 'dc-resolution-study',
  title: 'DC Resolution Study',
  description: '같은 물리 문제를 coarse/fine task로 연속 실행해 named task orchestration을 확인합니다.',
  concepts: Object.freeze([
    '재사용 가능한 task factory',
    '이전 result.state를 다음 sim.run()에 전달',
    '여러 task의 RecordedData와 trace 비교',
  ]),
  experimentSourceBundle: dcResolutionStudyExperimentSourceBundle,
  verification: Object.freeze({
    kernelTasks: Object.freeze(['solveCoarse', 'solveFine']),
    recordedData: Object.freeze(['coarseTotalCurrent', 'fineTotalCurrent']),
    expectations: Object.freeze([
      'trace 순서 = solveCoarse → solveFine',
      'stateless DC task 사이에서 state revision 유지',
      '두 total current 모두 14.9 A ± 1e-6',
    ]),
  }),
}) satisfies CaembleProgramExample
