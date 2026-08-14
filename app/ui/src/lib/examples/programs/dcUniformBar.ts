import { createExperimentSourceBundle } from '../../cad/source/document'
import type { CaembleProgramExample } from './types'

export const dcUniformBarExperimentCode = `import { experiment } from '@caemble/core'
import { Conductor } from './geometry'
import { Copper } from './material'

export default experiment({
  lengthUnit: 'mm',

  varsSchema: {
    conductorSize: { min: [100, 5, 5], max: [100, 5, 5] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
    sourceVoltage: { min: 1, max: 1 },
    referenceVoltage: { min: 0, max: 0 },
  },

  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.conductorSize}
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
    totalCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
})
`

export const dcUniformBarMaterialCode = `import { Mat, Material } from '@caemble/core'

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

export const dcUniformBarGeometryCode = `import { type Geometry, type Vec3 } from '@caemble/core'

export const Conductor: Geometry<{ size: Vec3 }> = ({ size }) => <box size={size} />

export const Probe: Geometry = () => <box size={[2, 2, 2]} />
`

export const dcUniformBarTaskCode = `import { defineTask } from '@caemble/core'
import { Probe } from '../geometry'
import { Copper } from '../material'

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.1.0' },
  lengthUnit: 'mm',
  geometry: ({ vars }) => (
    <Probe
      id="probe"
      pos={[0, -10, 0]}
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
          value: [20, 11, 11],
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
          value: vars.referenceVoltage,
          unit: 'mV',
          quantityKind: 'electromagnetism.Voltage',
        },
      },
    },
  ],

  outputs: [
    {
      key: 'totalCurrent',
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

export const dcUniformBarSimulationCode = `async def simulate(*, sim, tasks, vars):
    result = await sim.run(tasks["solveCurrent"])
    await sim.record("totalCurrent", result["artifacts"]["totalCurrent"])
    return result["state"]
`

export const dcUniformBarExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': dcUniformBarExperimentCode,
  'geometry.tsx': dcUniformBarGeometryCode,
  'material.tsx': dcUniformBarMaterialCode,
  'simulate.py': dcUniformBarSimulationCode,
  'tasks/solveCurrent.tsx': dcUniformBarTaskCode,
})

export const dcUniformBarExample = Object.freeze({
  id: 'dc-uniform-bar',
  title: 'DC Uniform Bar',
  description: '가장 작은 Experiment Program으로 균일 구리 막대의 전체 전류를 계산합니다.',
  concepts: Object.freeze([
    'Experiment geometry group과 surface target',
    'task factory와 단일 sim.run()',
    '중간 artifact handle을 RecordedData로 기록',
  ]),
  experimentSourceBundle: dcUniformBarExperimentSourceBundle,
  verification: Object.freeze({
    kernelTasks: Object.freeze(['solveCurrent']),
    recordedData: Object.freeze(['totalCurrent']),
    expectations: Object.freeze([
      'totalCurrent = 14.9 A ± 1e-6',
      'dc-current-density@0.1.0 호출 1회',
      'stateless DC 실행은 입력 state revision 유지',
    ]),
    fixture: Object.freeze({
      records: Object.freeze([
        Object.freeze({
          name: 'totalCurrent',
          dtype: 'float64',
          shape: Object.freeze([]),
          value: 14.9,
          absoluteTolerance: 1e-6,
        }),
      ]),
      terminal: Object.freeze({
        kind: 'complete',
        sequence: 2,
        recordSequences: Object.freeze([1]),
      }),
    }),
  }),
}) satisfies CaembleProgramExample
