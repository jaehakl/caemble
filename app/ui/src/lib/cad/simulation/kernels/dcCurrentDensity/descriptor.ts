import { identityCartesianBasis } from '../../../../quantitykind/identityBasis'
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

const crossSectionPosition = Object.freeze({
  description: 'Normalized axial position of the requested cross-section.',
  data: Object.freeze({
    dtype: 'float64',
    quantityKind: 'DimensionlessRatio',
    unit: '{fraction}',
    minimum: 0,
    maximum: 1,
    exclusiveMinimum: true,
    exclusiveMaximum: true,
  }),
} as const)

export const dcCurrentDensityDescriptor = Object.freeze({
  name: 'dc-current-density',
  version: '0.0.0',
  description: 'Solves steady-state electric potential and requested current outputs in one conductor.',
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
      role: 'conductor',
      description: 'The homogeneous isotropic conductor targeted by dc.voxel-grid.',
      target: Object.freeze({
        category: 'initializations',
        methodId: 'dc.voxel-grid',
      }),
      properties: Object.freeze({
        'electrical.conductivity': Object.freeze({
          description: 'Positive isotropic electrical-conductivity tensor in the global identity basis.',
          data: Object.freeze({
            dtype: 'float64',
            quantityKind: 'electromagnetism.ElectricConductivity',
            unit: 'S.m-1',
            basis: identityCartesianBasis,
          }),
        }),
      }),
    }),
  ]),
  inputPorts: Object.freeze({}),
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
        methodId: 'dc.voxel-grid',
        description: 'Defines the cell-centered conductor voxel grid in axial, u, and v order.',
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
        methodId: 'dc.source-potential',
        description: 'Applies the source terminal electric potential.',
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        target: oneStructureSurface,
        parameters: Object.freeze({
          voltage: Object.freeze({
            description: 'Source terminal electric potential.',
            data: Object.freeze({
              dtype: 'float64',
              quantityKind: 'electromagnetism.Voltage',
              unit: 'V',
            }),
          }),
        }),
      }),
      Object.freeze({
        methodId: 'dc.reference-potential',
        description: 'Applies the reference terminal electric potential.',
        minimumOccurrences: 1,
        maximumOccurrences: 1,
        target: oneStructureSurface,
        parameters: Object.freeze({
          voltage: Object.freeze({
            description: 'Reference terminal electric potential.',
            data: Object.freeze({
              dtype: 'float64',
              quantityKind: 'electromagnetism.Voltage',
              unit: 'V',
            }),
          }),
        }),
      }),
    ]),
    outputs: Object.freeze([
      Object.freeze({
        methodId: 'dc.current-density',
        description: 'Produces a two-dimensional current-density cross-section.',
        minimumOccurrences: 0,
        maximumOccurrences: Number.MAX_SAFE_INTEGER,
        target: oneStructureGeometry,
        parameters: Object.freeze({ crossSectionPosition }),
        artifactType: 'caemble.dc/current-density@1',
        data: Object.freeze({
          dtype: 'float64',
          quantityKind: 'electromagnetism.ElectricCurrentDensity',
          unit: 'A.m-2',
          basis: identityCartesianBasis,
          axes: Object.freeze([
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
          ]),
        }),
      }),
      Object.freeze({
        methodId: 'dc.total-current',
        description: 'Produces absolute current integrated over a cross-section.',
        minimumOccurrences: 0,
        maximumOccurrences: Number.MAX_SAFE_INTEGER,
        target: oneStructureGeometry,
        parameters: Object.freeze({ crossSectionPosition }),
        artifactType: 'caemble.dc/total-current@1',
        data: Object.freeze({
          dtype: 'float64',
          quantityKind: 'electromagnetism.ElectricCurrent',
          unit: 'A',
        }),
      }),
      Object.freeze({
        methodId: 'dc.joule-heating',
        description: 'Produces volumetric Joule heating on the conductor voxel grid.',
        minimumOccurrences: 0,
        maximumOccurrences: 1,
        target: oneStructureGeometry,
        parameters: Object.freeze({}),
        artifactType: 'caemble.dc/joule-heating@1',
        data: Object.freeze({
          dtype: 'float64',
          quantityKind: 'PowerDensity',
          unit: 'W.m-3',
          axes: Object.freeze([
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
          ]),
        }),
      }),
    ]),
  }),
} as const satisfies KernelDescriptor)

export type DcCurrentDensityOutputRequest = KernelOutputRequest &
  Readonly<{
    methodId: 'dc.current-density' | 'dc.total-current' | 'dc.joule-heating'
  }>

export type DcCurrentDensityInitialization = KernelMethodCall &
  Readonly<{
    methodId: 'dc.voxel-grid'
  }>

export type DcCurrentDensityBoundaryCondition = KernelMethodCall &
  Readonly<{
    methodId: 'dc.source-potential' | 'dc.reference-potential'
  }>

export type DcCurrentDensityTaskConfig<
  Outputs extends readonly DcCurrentDensityOutputRequest[] = readonly DcCurrentDensityOutputRequest[],
> = Omit<KernelTaskConfig, 'initializations' | 'boundaryConditions' | 'outputs'> &
  Readonly<{
    initializations: readonly DcCurrentDensityInitialization[]
    boundaryConditions: readonly DcCurrentDensityBoundaryCondition[]
    outputs: Outputs
  }>

export type DcArtifactTypes<Config extends DcCurrentDensityTaskConfig> = Readonly<{
  [Request in Config['outputs'][number] as Request['key']]: Request['methodId'] extends 'dc.current-density'
    ? 'caemble.dc/current-density@1'
    : Request['methodId'] extends 'dc.total-current'
      ? 'caemble.dc/total-current@1'
      : 'caemble.dc/joule-heating@1'
}>
