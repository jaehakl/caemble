export const defaultExperimentProgramCode = `import { experiment } from '@caemble/core'
import { dcCurrentDensity } from '@caemble/kernels'

function ExperimentDevice() {
  return <box size={[1, 1, 1]} />
}

export default experiment({
  lengthUnit: 'mm',
  varsSchema: {
    sourceVoltage: { min: 1, max: 1 },
    referenceVoltage: { min: 0, max: 0 },
  },
  geometry: () => <ExperimentDevice id="experiment-device" />,

  tasks: ({ vars }) => ({
    electric: dcCurrentDensity({
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
            gridShape: {
              dtype: 'int32',
              axes: [{ length: 3 }],
              value: [100, 41, 41],
            },
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
  }),

  recordedData: {
    measuredCurrent: {
      dtype: 'float64',
      unit: 'A',
      quantityKind: 'electromagnetism.ElectricCurrent',
    },
  },

  simulate: async ({ sim, tasks }) => {
    const electric = await sim.run(tasks.electric)

    sim.record('measuredCurrent', electric.artifacts.totalCurrent)
    sim.release(electric.artifacts.currentDensity)

    return electric.state
  },
})
`
