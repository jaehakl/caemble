import type { CaembleProgramExample } from './types'

export const dcNotchedCurrentDensityStructureCode = `import {
  Mat,
  Material,
  structure,
  type Geometry,
  type Vec3,
} from '@caemble/core'

const NotchedConductor: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({ notchPosition, notchSize, size }) => (
  <subtract>
    <box size={size} />
    <box pos={notchPosition} size={notchSize} />
  </subtract>
)

export default structure({
  lengthUnit: 'mm',

  varsSchema: {
    conductorSize: { min: [100, 12, 10], max: [100, 12, 10] },
    notchPosition: { min: [0, 4.5, 3], max: [0, 4.5, 3] },
    notchSize: { min: [30, 5, 6], max: [30, 5, 6] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
  },

  geometry: ({ vars }) => (
    <NotchedConductor
      id="conductor"
      size={vars.conductorSize}
      notchPosition={vars.notchPosition}
      notchSize={vars.notchSize}
      materials={[
        new Material('Copper', 'reference', {
          errorRate: 0,
          'electrical.conductivity': {
            dtype: 'float64',
            value: Mat(vars.electricalConductivity),
            unit: 'S.m-1',
          },
          color: '#c2410c',
        }),
      ]}
    />
  ),

  geometryGroup: {
    conductor: ['conductor'],
  },

  surfaceGroup: {
    sourceTerminal: ['conductor/surface-1'],
    referenceTerminal: ['conductor/surface-2'],
  },
})
`

export const dcNotchedCurrentDensityExperimentCode = `import { experiment } from '@caemble/core'
import { dcCurrentDensity } from '@caemble/kernels'

function fieldTask(sourceVoltage: number) {
  return dcCurrentDensity({
  parameters: {
    relativeTolerance: {
      dtype: 'float64',
      value: 1e-8,
      unit: '{fraction}',
      quantityKind: 'DimensionlessRatio',
    },
    maxIterations: 2000,
  },

  initializations: [
    {
      target: ['structure.geometry.conductor'],
      methodId: 'dc.voxel-grid',
      parameters: {
        gridShape: {
          dtype: 'int32',
          axes: [{ length: 3 }],
          value: [40, 21, 21],
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
      key: 'currentDensity',
      target: ['structure.geometry.conductor'],
      methodId: 'dc.current-density',
      parameters: {
        crossSectionPosition: {
          dtype: 'float64',
          value: 0.35,
          unit: '{fraction}',
          quantityKind: 'DimensionlessRatio',
        },
      },
    },
    {
      key: 'totalCurrent',
      target: ['structure.geometry.conductor'],
      methodId: 'dc.total-current',
      parameters: {
        crossSectionPosition: {
          dtype: 'float64',
          value: 0.35,
          unit: '{fraction}',
          quantityKind: 'DimensionlessRatio',
        },
      },
    },
  ],
  })
}

function FieldProbe() {
  return <box size={[3, 3, 3]} />
}

export default experiment({
  lengthUnit: 'mm',

  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
  },

  geometry: () => <FieldProbe id="field-probe" pos={[0, -15, 0]} />,

  tasks: ({ vars }) => ({
    solveField: fieldTask(vars.sourceVoltage),
  }),

  recordedData: {
    currentDensity: {
      dtype: 'float64',
      unit: 'A.m-2',
      quantityKind: 'electromagnetism.ElectricCurrentDensity',
      basis: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      axes: [
        { name: 'cross-section v', unit: 'm', quantityKind: 'Length' },
        { name: 'cross-section u', unit: 'm', quantityKind: 'Length' },
      ],
    },
    totalCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },

})
`

export const dcNotchedCurrentDensitySimulationCode = `async def simulate(*, sim, tasks, vars, world):
    result = await sim.run(tasks["solveField"])
    await sim.record("currentDensity", result["artifacts"]["currentDensity"])
    await sim.record("totalCurrent", result["artifacts"]["totalCurrent"])
    return result["state"]
`

export const dcNotchedCurrentDensityExample = Object.freeze({
  id: 'dc-notched-current-density',
  title: 'DC Notched Current Density',
  description: 'notch 주변 전류 집중을 2D vector field와 전체 전류로 함께 기록합니다.',
  concepts: Object.freeze([
    'simulation이 제공하는 initialState',
    '한 task에서 여러 ArtifactRef 요청',
    '동적 2D axes와 vector Quantity RecordedData',
  ]),
  structureCode: dcNotchedCurrentDensityStructureCode,
  experimentCode: dcNotchedCurrentDensityExperimentCode,
  simulationCode: dcNotchedCurrentDensitySimulationCode,
  verification: Object.freeze({
    kernelTasks: Object.freeze(['solveField']),
    recordedData: Object.freeze(['currentDensity', 'totalCurrent']),
    expectations: Object.freeze([
      'currentDensity value shape = [21, 21, 3]',
      '모든 field 성분과 axis tick이 유한값',
      'totalCurrent > 0 A',
    ]),
  }),
}) satisfies CaembleProgramExample
