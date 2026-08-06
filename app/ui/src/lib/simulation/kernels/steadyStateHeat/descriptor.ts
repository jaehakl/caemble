import { identityCartesianBasis } from '../../../quantitykind/identityBasis'
import type { KernelDescriptor, KernelMethodCall, KernelOutputRequest, KernelTaskConfig } from '../../kernelContract'

const oneStructureGeometry = Object.freeze({
  source: 'structure',
  kind: 'geometry',
  minimumTargets: 1,
  maximumTargets: 1,
  minimumResolved: 1,
  maximumResolved: 1,
} as const)

const oneStructureSurface = Object.freeze({
  source: 'structure',
  kind: 'surface',
  minimumTargets: 1,
  maximumTargets: 1,
  minimumResolved: 1,
  maximumResolved: 1,
} as const)

const axialVoxelAxes = Object.freeze([
  Object.freeze({
    name: 'axial position',
    quantityKind: 'Length',
    unit: 'm',
  }),
  Object.freeze({
    name: 'cross-section v',
    quantityKind: 'Length',
    unit: 'm',
  }),
  Object.freeze({
    name: 'cross-section u',
    quantityKind: 'Length',
    unit: 'm',
  }),
] as const)

export const steadyStateHeatDescriptor = Object.freeze({
  name: 'steady-state-heat',
  version: '0.0.0',
  description: 'Solves steady-state heat conduction with fixed-temperature ends and adiabatic side walls.',
  referenceLengthUnit: 'm',
  minimumOutputs: 1,
  parameters: Object.freeze({
    relativeTolerance: Object.freeze({
      description: 'Relative convergence tolerance for the preconditioned conjugate-gradient solve.',
      data: Object.freeze({
        dtype: 'float64',
        quantityKind: 'DimensionlessRatio',
        unit: '{fraction}',
        minimum: 0,
        maximum: 1,
        exclusiveMinimum: true,
        exclusiveMaximum: true,
      }),
    }),
    maxIterations: Object.freeze({
      description: 'Maximum number of solver iterations.',
      data: Object.freeze({ dtype: 'int32', minimum: 1 }),
    }),
  }),
  materials: Object.freeze([
    Object.freeze({
      role: 'thermalDomain',
      description: 'The homogeneous isotropic thermal domain targeted by heat.voxel-grid.',
      target: Object.freeze({
        category: 'initializations',
        methodId: 'heat.voxel-grid',
      }),
      properties: Object.freeze({
        'thermal.conductivity': Object.freeze({
          description: 'Positive isotropic thermal-conductivity tensor in the global identity basis.',
          data: Object.freeze({
            dtype: 'float64',
            quantityKind: 'thermodynamics.ThermalConductivity',
            unit: 'W.m-1.K-1',
            basis: identityCartesianBasis,
          }),
        }),
      }),
    }),
  ]),
  inputPorts: Object.freeze({
    heatSource: Object.freeze({
      description: 'Optional volumetric heat source sampled on the same voxel grid.',
      artifactTypes: Object.freeze(['caemble.dc/joule-heating@1'] as const),
      minimumOccurrences: 0,
      maximumOccurrences: 1,
      data: Object.freeze({
        dtype: 'float64',
        quantityKind: 'PowerDensity',
        unit: 'W.m-3',
        axes: axialVoxelAxes,
      }),
    }),
  }),
  observations: Object.freeze({
    iterations: Object.freeze({
      description: 'Number of completed PCG iterations.',
      type: 'number',
    }),
    relativeResidual: Object.freeze({
      description: 'Final relative residual of the PCG solve.',
      type: 'number',
    }),
  }),
  methods: Object.freeze({
    initializations: Object.freeze([
      Object.freeze({
        methodId: 'heat.voxel-grid',
        description: 'Defines the cell-centered thermal voxel grid in axial, u, and v order.',
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        target: oneStructureGeometry,
        parameters: Object.freeze({
          gridShape: Object.freeze({
            description: 'Number of cells along the s, u, and v grid axes.',
            data: Object.freeze({
              dtype: 'int32',
              axes: Object.freeze([Object.freeze({ length: 3 })]),
              minimum: 3,
            }),
          }),
        }),
      }),
    ]),
    boundaryConditions: Object.freeze([
      Object.freeze({
        methodId: 'heat.fixed-temperature',
        description: 'Applies a fixed temperature to one complete end surface.',
        minimumOccurrences: 2,
        maximumOccurrences: 2,
        target: oneStructureSurface,
        parameters: Object.freeze({
          temperature: Object.freeze({
            description: 'Fixed surface temperature.',
            data: Object.freeze({
              dtype: 'float64',
              quantityKind: 'thermodynamics.Temperature',
              unit: 'K',
              minimum: 0,
            }),
          }),
        }),
      }),
    ]),
    outputs: Object.freeze([
      Object.freeze({
        methodId: 'heat.temperature',
        description: 'Produces the three-dimensional voxel temperature field.',
        minimumOccurrences: 0,
        maximumOccurrences: 1,
        target: oneStructureGeometry,
        parameters: Object.freeze({}),
        artifactType: 'caemble.heat/temperature@1',
        data: Object.freeze({
          dtype: 'float64',
          quantityKind: 'thermodynamics.Temperature',
          unit: 'K',
          axes: axialVoxelAxes,
        }),
      }),
      Object.freeze({
        methodId: 'heat.maximum-temperature',
        description: 'Produces the maximum temperature among occupied voxel cells.',
        minimumOccurrences: 0,
        maximumOccurrences: 1,
        target: oneStructureGeometry,
        parameters: Object.freeze({}),
        artifactType: 'caemble.heat/maximum-temperature@1',
        data: Object.freeze({
          dtype: 'float64',
          quantityKind: 'thermodynamics.Temperature',
          unit: 'K',
        }),
      }),
    ]),
  }),
} as const satisfies KernelDescriptor)

export type SteadyStateHeatOutputRequest = KernelOutputRequest &
  Readonly<{
    methodId: 'heat.temperature' | 'heat.maximum-temperature'
  }>

export type SteadyStateHeatInitialization = KernelMethodCall &
  Readonly<{
    methodId: 'heat.voxel-grid'
  }>

export type SteadyStateHeatBoundaryCondition = KernelMethodCall &
  Readonly<{
    methodId: 'heat.fixed-temperature'
  }>

export type SteadyStateHeatTaskConfig<
  Outputs extends readonly SteadyStateHeatOutputRequest[] = readonly SteadyStateHeatOutputRequest[],
> = Omit<KernelTaskConfig, 'initializations' | 'boundaryConditions' | 'outputs'> &
  Readonly<{
    initializations: readonly SteadyStateHeatInitialization[]
    boundaryConditions: readonly SteadyStateHeatBoundaryCondition[]
    outputs: Outputs
  }>

export type SteadyStateHeatArtifactTypes<Config extends SteadyStateHeatTaskConfig> = Readonly<{
  [Request in Config['outputs'][number] as Request['key']]: Request['methodId'] extends 'heat.temperature'
    ? 'caemble.heat/temperature@1'
    : 'caemble.heat/maximum-temperature@1'
}>
