import { createExperimentSourceBundle } from '../../cad'
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
  geometryGroup: { conductor: ['conductor'] },
  surfaceGroup: {
    sourceTerminal: ['conductor/surface-1'],
    referenceTerminal: ['conductor/surface-2'],
  },
})
`

export const electroThermalUniformBarExperimentCode = `import { experiment } from '@caemble/core'

export default experiment({
  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
    fixedTemperature: { min: 293.15, max: 293.15 },
  },
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
})
`

export const electroThermalUniformBarElectricTaskCode = `import { defineTask } from '@caemble/core'

function ElectricProbe() {
  return <box size={[2, 2, 2]} />
}

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.0.0' },
  lengthUnit: 'mm',
  geometry: () => <ElectricProbe id="electric-probe" pos={[0, -10, 0]} />,
  config: ({ vars }) => ({
    parameters: {
      relativeTolerance: { dtype: 'float64', value: 1e-10, unit: '{fraction}', quantityKind: 'DimensionlessRatio' },
      maxIterations: 1000,
    },
    initializations: [{
      target: ['structure.geometry.conductor'],
      methodId: 'dc.voxel-grid',
      parameters: { gridShape: { dtype: 'int32', axes: [{ length: 3 }], value: [20, 11, 11] } },
    }],
    boundaryConditions: [
      {
        target: ['structure.surface.sourceTerminal'],
        methodId: 'dc.source-potential',
        parameters: { voltage: { dtype: 'float64', value: vars.sourceVoltage, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
      },
      {
        target: ['structure.surface.referenceTerminal'],
        methodId: 'dc.reference-potential',
        parameters: { voltage: { dtype: 'float64', value: 0, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
      },
    ],
    outputs: [
      {
        key: 'totalCurrent',
        target: ['structure.geometry.conductor'],
        methodId: 'dc.total-current',
        parameters: { crossSectionPosition: { dtype: 'float64', value: 0.5, unit: '{fraction}', quantityKind: 'DimensionlessRatio' } },
      },
      { key: 'jouleHeating', target: ['structure.geometry.conductor'], methodId: 'dc.joule-heating', parameters: {} },
    ],
  }),
})
`

export const electroThermalUniformBarThermalTaskCode = `import { defineTask } from '@caemble/core'

function ThermalProbe() {
  return <box size={[2, 2, 2]} />
}

export default defineTask({
  kernel: { name: 'steady-state-heat', version: '0.0.0' },
  lengthUnit: 'mm',
  geometry: () => <ThermalProbe id="thermal-probe" pos={[0, -14, 0]} />,
  config: ({ vars }) => ({
    parameters: {
      relativeTolerance: { dtype: 'float64', value: 1e-10, unit: '{fraction}', quantityKind: 'DimensionlessRatio' },
      maxIterations: 1000,
    },
    initializations: [{
      target: ['structure.geometry.conductor'],
      methodId: 'heat.voxel-grid',
      parameters: { gridShape: { dtype: 'int32', axes: [{ length: 3 }], value: [20, 11, 11] } },
    }],
    boundaryConditions: [
      {
        target: ['structure.surface.sourceTerminal'],
        methodId: 'heat.fixed-temperature',
        parameters: { temperature: { dtype: 'float64', value: vars.fixedTemperature, unit: 'K', quantityKind: 'thermodynamics.Temperature' } },
      },
      {
        target: ['structure.surface.referenceTerminal'],
        methodId: 'heat.fixed-temperature',
        parameters: { temperature: { dtype: 'float64', value: vars.fixedTemperature, unit: 'K', quantityKind: 'thermodynamics.Temperature' } },
      },
    ],
    outputs: [
      { key: 'temperature', target: ['structure.geometry.conductor'], methodId: 'heat.temperature', parameters: {} },
      { key: 'maximumTemperature', target: ['structure.geometry.conductor'], methodId: 'heat.maximum-temperature', parameters: {} },
    ],
  }),
})
`

export const electroThermalUniformBarSimulationCode = `async def simulate(*, sim, tasks, vars):
    electric = await sim.run(tasks["electric"])
    thermal = await sim.run(
        tasks["thermal"],
        state=electric["state"],
        inputs={"heatSource": electric["artifacts"]["jouleHeating"]},
    )
    await sim.record("totalCurrent", electric["artifacts"]["totalCurrent"])
    await sim.record("temperature", thermal["artifacts"]["temperature"])
    await sim.record(
        "maximumTemperature",
        thermal["artifacts"]["maximumTemperature"],
    )
    sim.release(electric["artifacts"]["jouleHeating"])
    return thermal["state"]
`

export const electroThermalUniformBarExperimentSourceBundle = createExperimentSourceBundle({
  'experiment.tsx': electroThermalUniformBarExperimentCode,
  'simulate.py': electroThermalUniformBarSimulationCode,
  'tasks/electric.tsx': electroThermalUniformBarElectricTaskCode,
  'tasks/thermal.tsx': electroThermalUniformBarThermalTaskCode,
})

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
  experimentSourceBundle: electroThermalUniformBarExperimentSourceBundle,
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
