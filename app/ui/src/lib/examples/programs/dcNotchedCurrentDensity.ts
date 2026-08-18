import { createExperimentSourceBundle } from '../../cad/source/document'
import type { CaembleProgramExample } from './types'

export const dcNotchedCurrentDensityExperimentCode = `import { experiment } from '@caemble/core'
import { NotchedConductor } from './geometry'
import { Copper } from './material'

export default experiment({
  lengthUnit: 'mm',

  varsSchema: {
    conductorSize: { min: [100, 12, 10], max: [100, 12, 10] },
    notchPosition: { min: [0, 4.5, 3], max: [0, 4.5, 3] },
    notchSize: { min: [30, 5, 6], max: [30, 5, 6] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
    sourceVoltage: { min: 1, max: 1 },
  },

  geometry: ({ vars }) => (
    <NotchedConductor
      id="conductor"
      size={vars.conductorSize}
      notchPosition={vars.notchPosition}
      notchSize={vars.notchSize}
      materials={{ body: Copper(vars.electricalConductivity as number) }}
    />
  ),

  geometryGroup: {
    conductor: ['conductor'],
  },

  surfaceGroup: {
    sourceTerminal: ['conductor/surface-1'],
    referenceTerminal: ['conductor/surface-2'],
  },
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

export const dcNotchedCurrentDensityMaterialCode = `import { Mat, Material } from '@caemble/core'

export const Copper = (electricalConductivity: number) =>
  new Material('Copper', 'reference', {
    errorRate: 0,
    'electrical.conductivity': {
      dtype: 'float64',
      value: Mat(electricalConductivity),
      unit: 'S.m-1',
    },
    color: '#c2410c',
  })
`

export const dcNotchedCurrentDensityGeometryCode = `import { type Geometry, type Vec3 } from '@caemble/core'

export const NotchedConductor: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({ notchPosition, notchSize, size }) => (
  <subtract>
    <box size={size} />
    <box position={notchPosition} size={notchSize} />
  </subtract>
)

export const FieldProbe: Geometry = () => <box size={[3, 3, 3]} />
`

export const dcNotchedCurrentDensityTaskCode = `import { defineTask } from '@caemble/core'
import { FieldProbe } from '../geometry'
import { Copper } from '../material'

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.1.0' },
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <FieldProbe
      id="field-probe"
      position={[0, -15, 0]}
      materials={{ body: Copper(vars.electricalConductivity as number) }}
    />
  ),
  config: ({ vars }) => ({
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
      target: ['experiment.geometry.conductor'],
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
      key: 'currentDensity',
      target: ['experiment.geometry.conductor'],
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
      target: ['experiment.geometry.conductor'],
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
  }),
})
`

export const dcNotchedCurrentDensitySimulationCode = `async def simulate(*, sim, tasks, vars):
    result = await sim.run(tasks["solveField"])
    await sim.record("currentDensity", result["artifacts"]["currentDensity"])
    await sim.record("totalCurrent", result["artifacts"]["totalCurrent"])
    return result["state"]
`

export const dcNotchedCurrentDensityExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': dcNotchedCurrentDensityExperimentCode,
  'geometry.tsx': dcNotchedCurrentDensityGeometryCode,
  'material.tsx': dcNotchedCurrentDensityMaterialCode,
  'simulate.py': dcNotchedCurrentDensitySimulationCode,
  'tasks/solveField.tsx': dcNotchedCurrentDensityTaskCode,
})

export const dcNotchedCurrentDensityExample = Object.freeze({
  id: 'dc-notched-current-density',
  title: 'DC Notched Current Density',
  description: 'notch 주변 전류 집중을 2D vector field와 전체 전류로 함께 기록합니다.',
  concepts: Object.freeze([
    'simulation이 제공하는 initialState',
    '한 task에서 여러 artifact handle 요청',
    '동적 2D axes와 vector Quantity RecordedData',
  ]),
  experimentSourceBundle: dcNotchedCurrentDensityExperimentSourceBundle,
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
