export const defaultExperimentProgramCode = `import {
  Mat,
  Material,
  experiment,
} from '@caemble/core'
import { Conductor } from './geometry'

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    conductorSize: { min: [100, 12, 10], max: [100, 12, 10] },
    notchSize: { min: [20, 4, 5], max: [40, 6, 7] },
    notchPosition: { min: [-10, 4, 2.5], max: [10, 5, 3.5] },
    electricalConductivity: { min: 5.96e7, max: 5.96e7 },
    sourceVoltage: { min: 1, max: 1 },
    referenceVoltage: { min: 0, max: 0 },
  },
  geometry: ({ vars }) => (
    <Conductor
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
  recordedData: {
    measuredCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },
})
`

export const defaultExperimentGeometryCode = `import { type Geometry, type Vec3 } from '@caemble/core'

export const Conductor: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({ notchPosition, notchSize, size }) => (
  <subtract>
    <box size={size} />
    <box pos={notchPosition} size={notchSize} />
  </subtract>
)

export const ExperimentDevice: Geometry = () => <box size={[1, 1, 1]} />
`

export const defaultExperimentTaskCode = `import { defineTask } from '@caemble/core'
import { ExperimentDevice } from '../geometry'

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.1.0' },
  lengthUnit: 'mm',
  geometry: () => <ExperimentDevice id="experiment-device" />,
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
    initializations: [{
      methodId: 'dc.voxel-grid',
      target: ['experiment.geometry.conductor'],
      parameters: { gridShape: { dtype: 'int32', axes: [{ length: 3 }], value: [100, 41, 41] } },
    }],
    boundaryConditions: [
      {
        methodId: 'dc.source-potential',
        target: ['experiment.surface.sourceTerminal'],
        parameters: { voltage: { dtype: 'float64', value: vars.sourceVoltage, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
      },
      {
        methodId: 'dc.reference-potential',
        target: ['experiment.surface.referenceTerminal'],
        parameters: { voltage: { dtype: 'float64', value: vars.referenceVoltage, unit: 'mV', quantityKind: 'electromagnetism.Voltage' } },
      },
    ],
    outputs: [
      {
        key: 'currentDensity',
        methodId: 'dc.current-density',
        target: ['experiment.geometry.conductor'],
        parameters: { crossSectionPosition: { dtype: 'float64', value: 0.35, unit: '{fraction}', quantityKind: 'DimensionlessRatio' } },
      },
      {
        key: 'totalCurrent',
        methodId: 'dc.total-current',
        target: ['experiment.geometry.conductor'],
        parameters: { crossSectionPosition: { dtype: 'float64', value: 0.35, unit: '{fraction}', quantityKind: 'DimensionlessRatio' } },
      },
    ],
  }),
})
`
