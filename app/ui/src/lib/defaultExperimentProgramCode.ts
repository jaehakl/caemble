export const defaultExperimentProgramCode = `import { experiment } from '@caemble/core'

export default experiment({
  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
    referenceVoltage: { min: 0, max: 0 },
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

export const defaultExperimentTaskCode = `import { defineTask } from '@caemble/core'

function ExperimentDevice() {
  return <box size={[1, 1, 1]} />
}

export default defineTask({
  kernel: { name: 'dc-current-density', version: '0.0.0' },
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
    initializations: [
      {
        methodId: 'dc.voxel-grid',
        target: ['structure.geometry.conductor'],
        parameters: {
          gridShape: { dtype: 'int32', axes: [{ length: 3 }], value: [100, 41, 41] },
        },
      },
    ],
    boundaryConditions: [
      {
        methodId: 'dc.source-potential',
        target: ['structure.surface.sourceTerminal'],
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
        methodId: 'dc.reference-potential',
        target: ['structure.surface.referenceTerminal'],
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
        key: 'currentDensity',
        methodId: 'dc.current-density',
        target: ['structure.geometry.conductor'],
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
        methodId: 'dc.total-current',
        target: ['structure.geometry.conductor'],
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
