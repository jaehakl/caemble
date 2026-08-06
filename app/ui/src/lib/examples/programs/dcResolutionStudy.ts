import { dcUniformBarStructureCode } from './dcUniformBar'
import type { CaembleProgramExample } from './types'

export const dcResolutionStudyExperimentCode = `import { experiment } from '@caemble/core'
import { dcCurrentDensity } from '@caemble/kernels'

function currentTask(
  gridShape: readonly [number, number, number],
  outputKey: string,
  sourceVoltage: number,
) {
  return dcCurrentDensity({
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
        target: ['structure.geometry.conductor'],
        methodId: 'dc.voxel-grid',
        parameters: {
          gridShape: {
            dtype: 'int32',
            axes: [{ length: 3 }],
            value: gridShape,
          },
        },
      },
    ],

    boundaryConditions: [
      {
        target: ['structure.surface.sourceTerminal'],
        methodId: 'dc.source-potential',
        parameters: {
          voltage: {
            dtype: 'float64',
            value: sourceVoltage,
            unit: 'mV',
            quantityKind: 'electromagnetism.Voltage',
          },
        },
      },
      {
        target: ['structure.surface.referenceTerminal'],
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
        key: outputKey,
        target: ['structure.geometry.conductor'],
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
  })
}

function ConvergenceProbe() {
  return <box size={[2, 2, 2]} />
}

export default experiment({
  lengthUnit: 'mm',

  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
  },

  geometry: () => <ConvergenceProbe id="convergence-probe" pos={[0, -10, 0]} />,

  tasks: ({ vars }) => ({
    solveCoarse: currentTask([10, 7, 7], 'coarseTotalCurrent', vars.sourceVoltage),
    solveFine: currentTask([20, 11, 11], 'fineTotalCurrent', vars.sourceVoltage),
  }),

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

export const dcResolutionStudySimulationCode = `async def simulate(*, sim, tasks, vars, world):
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

export const dcResolutionStudyExample = Object.freeze({
  id: 'dc-resolution-study',
  title: 'DC Resolution Study',
  description: '같은 물리 문제를 coarse/fine task로 연속 실행해 named task orchestration을 확인합니다.',
  concepts: Object.freeze([
    '재사용 가능한 task factory',
    '이전 result.state를 다음 sim.run()에 전달',
    '여러 task의 RecordedData와 trace 비교',
  ]),
  structureCode: dcUniformBarStructureCode,
  experimentCode: dcResolutionStudyExperimentCode,
  simulationCode: dcResolutionStudySimulationCode,
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
