import type { CaembleProgramExample } from './types'

export const electroThermalUniformBarStructureCode = `import {
  Mat,
  Material,
  structure,
  type Geometry,
  type Vec3,
} from '@caemble/core'

const Conductor: Geometry<{ size: Vec3 }> = ({ size }) => <box size={size} />

export default structure({
  lengthUnit: 'mm',

  varsSchema: {
    conductorSize: { min: [100, 5, 5], max: [100, 5, 5] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
    thermalConductivity: { min: 401, max: 401 },
  },

  geometry: ({ vars }) => (
    <Conductor
      id="conductor"
      size={vars.conductorSize}
      materials={[
        new Material('Copper', 'reference', {
          errorRate: 0,
          'electrical.conductivity': {
            dtype: 'float64',
            value: Mat(vars.electricalConductivity),
            unit: 'S.m-1',
          },
          'thermal.conductivity': {
            dtype: 'float64',
            value: Mat(vars.thermalConductivity),
            unit: 'W.m-1.K-1',
          },
          color: '#d97706',
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

export const electroThermalUniformBarExperimentCode = `import { experiment } from '@caemble/core'
import { dcCurrentDensity, steadyStateHeat } from '@caemble/kernels'

const gridShape = [20, 11, 11] as const

function electricTask(sourceVoltage: number) {
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
        key: 'totalCurrent',
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
      {
        key: 'jouleHeating',
        target: ['structure.geometry.conductor'],
        methodId: 'dc.joule-heating',
        parameters: {},
      },
    ],
  })
}

function thermalTask(fixedTemperature: number) {
  return steadyStateHeat({
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
        methodId: 'heat.voxel-grid',
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
        methodId: 'heat.fixed-temperature',
        parameters: {
          temperature: {
            dtype: 'float64',
            value: fixedTemperature,
            unit: 'K',
            quantityKind: 'thermodynamics.Temperature',
          },
        },
      },
      {
        target: ['structure.surface.referenceTerminal'],
        methodId: 'heat.fixed-temperature',
        parameters: {
          temperature: {
            dtype: 'float64',
            value: fixedTemperature,
            unit: 'K',
            quantityKind: 'thermodynamics.Temperature',
          },
        },
      },
    ],
    outputs: [
      {
        key: 'temperature',
        target: ['structure.geometry.conductor'],
        methodId: 'heat.temperature',
        parameters: {},
      },
      {
        key: 'maximumTemperature',
        target: ['structure.geometry.conductor'],
        methodId: 'heat.maximum-temperature',
        parameters: {},
      },
    ],
  })
}

function Probe() {
  return <box size={[2, 2, 2]} />
}

export default experiment({
  lengthUnit: 'mm',

  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
    fixedTemperature: { min: 293.15, max: 293.15 },
  },

  geometry: () => <Probe id="probe" pos={[0, -10, 0]} />,

  tasks: ({ vars }) => ({
    electric: electricTask(vars.sourceVoltage),
    thermal: thermalTask(vars.fixedTemperature),
  }),

  recordedData: {
    totalCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
    temperature: {
      dtype: 'float64',
      unit: 'K',
      quantityKind: 'thermodynamics.Temperature',
      axes: [
        { name: 'axial position', unit: 'm', quantityKind: 'Length' },
        { name: 'cross-section v', unit: 'm', quantityKind: 'Length' },
        { name: 'cross-section u', unit: 'm', quantityKind: 'Length' },
      ],
    },
    maximumTemperature: {
      dtype: 'float64',
      unit: 'K',
      quantityKind: 'thermodynamics.Temperature',
    },
  },

  simulate: async ({ sim, tasks }) => {
    const electric = await sim.run(tasks.electric)
    const thermal = await sim.run(tasks.thermal, {
      state: electric.state,
      inputs: {
        heatSource: electric.artifacts.jouleHeating,
      },
    })

    sim.record('totalCurrent', electric.artifacts.totalCurrent)
    sim.record('temperature', thermal.artifacts.temperature)
    sim.record('maximumTemperature', thermal.artifacts.maximumTemperature)
    sim.release(electric.artifacts.jouleHeating)
    return thermal.state
  },
})
`

export const electroThermalUniformBarExample = Object.freeze({
  id: 'electro-thermal-uniform-bar',
  title: 'Electro-Thermal Uniform Bar',
  description: 'DC 전류가 만든 Joule heating을 정상상태 Heat solver로 전달해 구리 막대 온도장을 계산합니다.',
  concepts: Object.freeze([
    '서로 다른 physics kernel의 typed artifact handoff',
    'Joule heating을 이용한 단방향 전기-열 결합',
    '3D temperature RecordedData와 maximum temperature',
  ]),
  structureCode: electroThermalUniformBarStructureCode,
  experimentCode: electroThermalUniformBarExperimentCode,
  verification: Object.freeze({
    kernelTasks: Object.freeze(['electric', 'thermal']),
    recordedData: Object.freeze(['totalCurrent', 'temperature', 'maximumTemperature']),
    expectations: Object.freeze([
      'trace 순서 = electric → thermal',
      'totalCurrent = 14.9 A ± 1e-6',
      'maximumTemperature ≈ 293.1685 K',
    ]),
  }),
}) satisfies CaembleProgramExample
