import type { CatalogRuntimeSlice } from '@/contracts/catalog'

export const canonicalShapedCatalog = {
  schemaVersion: 1,
  catalogRevision: 'synthetic-canonical-runner-catalog',
  solvers: [
    {
      name: 'dc-current-density',
      version: '0.1.0',
      contractDigest: 'd'.repeat(64),
      descriptor: {
        name: 'dc-current-density',
        version: '0.1.0',
        description: 'Synthetic catalog-backed current-density Solver.',
        referenceLengthUnit: 'm',
        minimumOutputs: 0,
        parameters: {
          relativeTolerance: {
            description: 'Relative convergence tolerance.',
            required: false,
            data: {
              dtype: 'float64',
              quantityKind: 'DimensionlessRatio',
              unit: '{fraction}',
              minimum: 0,
              maximum: 1,
              exclusiveMinimum: true,
              exclusiveMaximum: true,
            },
          },
        },
        materials: [],
        inputPorts: {},
        observations: {
          iterations: { description: 'Completed iterations.', type: 'number' },
        },
        methods: {
          initializations: [],
          boundaryConditions: [],
          outputs: [
            {
              methodId: 'dc.total-current',
              description: 'Produces current integrated over a cross-section.',
              minimumOccurrences: 0,
              maximumOccurrences: Number.MAX_SAFE_INTEGER,
              target: {
                source: 'experiment',
                kind: 'geometry',
                minimumTargets: 1,
                maximumTargets: 1,
                minimumResolved: 1,
                maximumResolved: 1,
              },
              parameters: {},
              artifactType: 'caemble.dc/total-current@1',
              data: {
                dtype: 'float64',
                quantityKind: 'electromagnetism.ElectricCurrent',
                unit: 'A',
              },
            },
          ],
        },
      },
    },
  ],
  quantityKinds: [
    {
      name: 'DimensionlessRatio',
      domain: 'general',
      tensorOrder: 0,
      description: null,
      opaque: false,
      applicableUnits: ['{fraction}'],
    },
    {
      name: 'electromagnetism.ElectricCurrent',
      domain: 'electromagnetism',
      tensorOrder: 0,
      description: 'Electric current.',
      opaque: false,
      applicableUnits: ['A'],
    },
  ],
  materialParameters: [],
  materialModels: [],
  materialGlobalQualifiers: ['temperature', 'pressure'],
  warnings: [],
} as const satisfies CatalogRuntimeSlice
