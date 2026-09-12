import { resultVisualizationSchema } from './resultValidators'
import { BOX_GRID_AXES, assertBoxGridProfile } from './boxGrid'
import { calculationDefinitionSchema } from './api/calculationValidators'
import { z } from 'zod'
import type {
  CatalogExperimentDetail,
  CatalogExperimentListItem,
  CatalogList,
  CatalogMaterialModel,
  ModelParameterSchema,
  CatalogMeta,
  CatalogQuantityKind,
  CatalogQuantityKindDetail,
  CatalogRuntimeSlice,
  CatalogSearchItem,
  CatalogSolverDetail,
  CatalogSolverListItem,
} from './catalog'

const nonnegativeIntegerSchema = z.number().int().nonnegative()

const quantityKindSchema = z
  .object({
    name: z.string(),
    domain: z.string(),
    tensorOrder: nonnegativeIntegerSchema,
    description: z.string().nullable(),
    opaque: z.boolean(),
    applicableUnits: z.array(z.string()),
  })
  .passthrough()

export const modelParameterSchema: z.ZodType<ModelParameterSchema> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('value'),
        dtype: z
          .enum([
            'float16',
            'float32',
            'float64',
            'int8',
            'int16',
            'int32',
            'int64',
            'uint8',
            'uint16',
            'uint32',
            'uint64',
            'bool',
            'string',
          ])
          .optional(),
        shape: z.array(nonnegativeIntegerSchema).optional(),
        quantityKind: z.string().optional(),
        unit: z.string().optional(),
        minimum: z.number().optional(),
        maximum: z.number().optional(),
        exclusiveMinimum: z.boolean().optional(),
        exclusiveMaximum: z.boolean().optional(),
        values: z.array(z.string()).optional(),
        description: z.string().optional(),
        omission: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('object'),
        fields: z.record(z.string(), modelParameterSchema),
        required: z.array(z.string()).optional(),
        description: z.string().optional(),
        omission: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('list'),
        items: modelParameterSchema,
        minimumLength: nonnegativeIntegerSchema.optional(),
        maximumLength: nonnegativeIntegerSchema.optional(),
        increasingBy: z.string().optional(),
        description: z.string().optional(),
        omission: z.string().optional(),
      })
      .strict(),
  ]),
)

const materialModelSchema = z
  .object({
    key: z.string(),
    labelKo: z.string(),
    description: z.string(),
    equation: z.string(),
    conventions: z.string(),
    parameterSchema: modelParameterSchema,
  })
  .passthrough()

const solverSummarySchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
  })
  .passthrough()

const solverQuantityKindUsageSchema = z
  .object({
    solverName: z.string(),
    solverVersion: z.string(),
    quantityKind: z.string().nullable().optional(),
    context: z.string(),
    path: z.string(),
    unit: z.string().nullable(),
  })
  .passthrough()

const solverMaterialRequirementSchema = z
  .object({
    solverName: z.string(),
    solverVersion: z.string(),
    role: z.string(),
    roleDescription: z.string().nullable().optional(),
    methodCategory: z.string().optional(),
    methodId: z.string().optional(),
    description: z.string().optional(),
    groupKey: z.string(),
    required: z.boolean(),
    quantityKind: z.string().nullable().optional(),
    unit: z.string().nullable().optional(),
  })
  .passthrough()

const kernelVec3Schema = z.tuple([z.number(), z.number(), z.number()])
const kernelCartesianBasisSchema = z.tuple([kernelVec3Schema, kernelVec3Schema, kernelVec3Schema])
const kernelDataAxisFields = {
  length: nonnegativeIntegerSchema.optional(),
  name: z.string().optional(),
  ticks: z.array(z.union([z.number(), z.string()])).optional(),
}
const kernelDataAxisSchema = z.union([
  z
    .object({
      ...kernelDataAxisFields,
      unit: z.string(),
      quantityKind: z.string(),
    })
    .passthrough(),
  z
    .object({
      ...kernelDataAxisFields,
      unit: z.never().optional(),
      quantityKind: z.never().optional(),
    })
    .passthrough(),
])
const kernelDataFields = { axes: z.array(kernelDataAxisSchema).optional() }
const kernelFloatDataFields = {
  dtype: z.enum(['float16', 'float32', 'float64', 'complex64']),
  unit: z.string(),
  quantityKind: z.string(),
  basis: kernelCartesianBasisSchema.optional(),
}
const kernelNonFloatDataFields = {
  dtype: z.enum(['bool', 'string', 'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64']),
  unit: z.never().optional(),
  quantityKind: z.never().optional(),
  basis: z.never().optional(),
}
const kernelValueFields = {
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.boolean().optional(),
  exclusiveMaximum: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  minimumLength: nonnegativeIntegerSchema.optional(),
}
const kernelDataSpecSchema = z.union([
  z.object({ ...kernelDataFields, ...kernelFloatDataFields }).passthrough(),
  z.object({ ...kernelDataFields, ...kernelNonFloatDataFields }).passthrough(),
])
const kernelValueSpecSchema = z.union([
  z.object({ ...kernelDataFields, ...kernelFloatDataFields, ...kernelValueFields }).passthrough(),
  z.object({ ...kernelDataFields, ...kernelNonFloatDataFields, ...kernelValueFields }).passthrough(),
])
const kernelArtifactDataSpecSchema = z.union([
  kernelDataSpecSchema,
  z
    .object({
      resourceKind: z.literal('structuredBundle'),
      members: z.record(z.string(), kernelDataSpecSchema),
    })
    .passthrough(),
])

const kernelParameterSchema = z
  .object({
    description: z.string(),
    required: z.boolean().optional(),
    data: kernelValueSpecSchema,
  })
  .passthrough()

const kernelTargetSchema = z
  .object({
    source: z.enum(['experiment', 'task', 'either']),
    kind: z.enum(['geometry', 'surface']),
    minimumTargets: nonnegativeIntegerSchema,
    maximumTargets: nonnegativeIntegerSchema,
    minimumResolved: nonnegativeIntegerSchema,
    maximumResolved: nonnegativeIntegerSchema,
  })
  .passthrough()

const kernelMethodSchema = z
  .object({
    methodId: z.string(),
    description: z.string(),
    minimumOccurrences: nonnegativeIntegerSchema,
    maximumOccurrences: nonnegativeIntegerSchema,
    target: kernelTargetSchema,
    parameters: z.record(z.string(), kernelParameterSchema),
  })
  .passthrough()

const kernelOutputMethodSchema = kernelMethodSchema.extend({
  artifactType: z.string(),
  data: kernelArtifactDataSpecSchema.and(
    z.object({
      visualization: resultVisualizationSchema,
      recording: z.enum(['mesh-field', 'mesh-series', 'structured-field']).optional(),
    }),
  ),
})

const kernelBoxOutputMethodSchema = kernelOutputMethodSchema.superRefine((method, context) => {
  try {
    const parsed = kernelDataSpecSchema.safeParse(method.data)
    if (!parsed.success || !['float32', 'float64'].includes(parsed.data.dtype))
      throw new Error('Numerical Outputs require float32 or float64 Box Grid tensors.')
    const data = parsed.data
    assertBoxGridProfile(data.boxGrid)
    if (JSON.stringify(data.axes?.map((axis) => axis.name)) !== JSON.stringify(BOX_GRID_AXES))
      throw new Error('Numerical Outputs require the fixed seven Box Grid axes.')
    if (
      data.axes?.[5].length !== data.boxGrid.channels.length ||
      data.axes?.[6].length !== data.boxGrid.components.length
    )
      throw new Error('Numerical Output channel and component dimensions must match their labels.')
    if (
      method.target.kind !== 'geometry' ||
      method.target.minimumTargets !== 1 ||
      method.target.maximumTargets !== 1 ||
      method.target.minimumResolved !== 1 ||
      method.target.maximumResolved !== 1
    )
      throw new Error('Numerical Outputs must target exactly one Box geometry.')
    if (!method.parameters.gridShape || method.parameters.gridShape.required === false)
      throw new Error('Numerical Outputs require the gridShape parameter.')
  } catch (error) {
    context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
  }
})

const kernelMaterialSchema = z
  .object({
    role: z.string(),
    description: z.string(),
    target: z.union([
      z.object({ category: z.enum(['initializations', 'boundaryConditions', 'outputs']), methodId: z.string() }),
      z.object({ category: z.literal('geometry'), source: z.enum(['experiment', 'task']) }),
    ]),
    modelGroups: z.array(z.object({ key: z.string(), required: z.boolean(), oneOf: z.array(z.string()).min(1) })),
  })
  .passthrough()

const kernelInputPortSchema = z
  .object({
    description: z.string(),
    artifactTypes: z.array(z.string()),
    minimumOccurrences: nonnegativeIntegerSchema,
    maximumOccurrences: nonnegativeIntegerSchema,
    data: kernelArtifactDataSpecSchema
      .nullable()
      .optional()
      .transform((data) => data ?? undefined),
  })
  .passthrough()

const kernelObservationSchema = z
  .object({
    description: z.string(),
    type: z.enum(['number', 'boolean', 'string']),
    required: z.boolean().optional(),
  })
  .passthrough()

const kernelDescriptorSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    referenceLengthUnit: z.string(),
    minimumOutputs: nonnegativeIntegerSchema.optional(),
    parameters: z.record(z.string(), kernelParameterSchema),
    materials: z.array(kernelMaterialSchema),
    inputPorts: z.record(z.string(), kernelInputPortSchema),
    observations: z.record(z.string(), kernelObservationSchema),
    visualizations: z
      .record(z.string(), z.object({ artifactType: z.string(), data: kernelArtifactDataSpecSchema }))
      .optional(),
    methods: z
      .object({
        initializations: z.array(kernelMethodSchema),
        boundaryConditions: z.array(kernelMethodSchema),
        outputs: z.array(kernelBoxOutputMethodSchema),
        exports: z.array(kernelOutputMethodSchema),
      })
      .passthrough(),
  })
  .passthrough()

const quantityKindDetailSchema = quantityKindSchema.extend({
  materialModels: z.array(
    z
      .object({
        key: z.string(),
        labelKo: z.string(),
        path: z.string(),
      })
      .passthrough(),
  ),
  solverUsages: z.array(solverQuantityKindUsageSchema),
})

const artifactConsumerSchema = z
  .object({
    solverName: z.string(),
    solverVersion: z.string(),
    inputPort: z.string(),
  })
  .passthrough()

const artifactProducerSchema = z
  .object({
    solverName: z.string(),
    solverVersion: z.string(),
    methodId: z.string(),
  })
  .passthrough()

const solverDetailSchema = solverSummarySchema.extend({
  descriptor: kernelDescriptorSchema,
  materialRequirements: z.array(solverMaterialRequirementSchema),
  quantityKindUsages: z.array(solverQuantityKindUsageSchema),
  producesArtifacts: z.array(
    z
      .object({
        methodId: z.string(),
        artifactType: z.string(),
        consumers: z.array(artifactConsumerSchema),
      })
      .passthrough(),
  ),
  consumesArtifacts: z.array(
    z
      .object({
        inputPort: z.string(),
        artifactType: z.string(),
        producers: z.array(artifactProducerSchema),
      })
      .passthrough(),
  ),
})

const experimentSolverSchema = solverSummarySchema
const experimentSummarySchema = z
  .object({
    key: z.string(),
    namespace: z.string(),
    repository: z.string(),
    version: z.string(),
    coordinate: z.string(),
    title: z.string(),
    description: z.string(),
    bundleHash: z.string(),
    concepts: z.array(z.string()),
    relatedSolvers: z.array(experimentSolverSchema),
  })
  .passthrough()

const experimentDetailSchema = experimentSummarySchema.extend({
  calculations: z.array(calculationDefinitionSchema),
  sourceBundle: z
    .object({
      files: z.record(z.string(), z.string()),
    })
    .passthrough(),
})

const catalogMetaSchema = z
  .object({
    catalogRevision: z.string(),
    quantityKindCount: nonnegativeIntegerSchema,
    materialModelCount: nonnegativeIntegerSchema,
    solverCount: nonnegativeIntegerSchema,
    experimentCount: nonnegativeIntegerSchema,
  })
  .passthrough()

const catalogSearchResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          kind: z.string(),
          key: z.string(),
          title: z.string(),
          subtitle: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough()

const runtimeSliceSchema = z
  .object({
    catalogRevision: z.string(),
    solvers: z.array(
      z
        .object({
          name: z.string(),
          version: z.string(),
          descriptor: kernelDescriptorSchema,
        })
        .passthrough(),
    ),
    quantityKinds: z.array(quantityKindSchema),
    materialModels: z.array(materialModelSchema),
    warnings: z.array(z.string()),
  })
  .passthrough()

function parseCatalogList<TItem>(value: unknown, itemSchema: z.ZodType): CatalogList<TItem> {
  return z
    .object({
      items: z.array(itemSchema),
      nextCursor: z.string().nullable(),
      total: nonnegativeIntegerSchema,
    })
    .passthrough()
    .parse(value) as CatalogList<TItem>
}

export function parseCatalogMeta(value: unknown): CatalogMeta {
  return catalogMetaSchema.parse(value) as CatalogMeta
}

export function parseCatalogQuantityKindList(value: unknown): CatalogList<CatalogQuantityKind> {
  return parseCatalogList(value, quantityKindSchema)
}

export function parseCatalogQuantityKindDetail(value: unknown): CatalogQuantityKindDetail {
  return quantityKindDetailSchema.parse(value) as CatalogQuantityKindDetail
}

export function parseCatalogMaterialModelList(value: unknown): CatalogList<CatalogMaterialModel> {
  return parseCatalogList(value, materialModelSchema)
}

export function parseCatalogMaterialModel(value: unknown): CatalogMaterialModel {
  return materialModelSchema.parse(value) as CatalogMaterialModel
}

export function parseCatalogSolverList(value: unknown): CatalogList<CatalogSolverListItem> {
  return parseCatalogList(value, solverSummarySchema)
}

export function parseCatalogSolverDetail(value: unknown): CatalogSolverDetail {
  return solverDetailSchema.parse(value) as CatalogSolverDetail
}

export function parseCatalogExperimentList(value: unknown): CatalogList<CatalogExperimentListItem> {
  return parseCatalogList(value, experimentSummarySchema)
}

export function parseCatalogExperimentDetail(value: unknown): CatalogExperimentDetail {
  return experimentDetailSchema.parse(value) as CatalogExperimentDetail
}

export function parseCatalogSearchResponse(value: unknown): Readonly<{ items: readonly CatalogSearchItem[] }> {
  return catalogSearchResponseSchema.parse(value) as Readonly<{ items: readonly CatalogSearchItem[] }>
}

export function parseCatalogRuntimeSlice(value: unknown): CatalogRuntimeSlice {
  return runtimeSliceSchema.parse(value) as CatalogRuntimeSlice
}
