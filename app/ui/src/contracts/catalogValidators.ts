import { z } from 'zod'
import type {
  CatalogExperimentDetail,
  CatalogExperimentListItem,
  CatalogList,
  CatalogMaterialModel,
  CatalogMaterialParameter,
  CatalogMaterialParameterDetail,
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

const materialParameterSchema = z
  .object({
    key: z.string(),
    domain: z.string(),
    labelKo: z.string(),
    quantityKind: z.string(),
    specialQualifiers: z.array(z.string()),
  })
  .passthrough()

const materialModelEndpointSchema = z
  .object({
    name: z.string(),
    quantityKind: z.string(),
  })
  .passthrough()

const materialModelSchema = z
  .object({
    key: z.string(),
    labelKo: z.string(),
    kind: z.literal('sampled_relation'),
    input: materialModelEndpointSchema,
    output: materialModelEndpointSchema,
    minimumSamples: nonnegativeIntegerSchema,
    sharedBasis: z.boolean(),
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
    methodCategory: z.string(),
    methodId: z.string(),
    materialParameter: z.string().nullable().optional(),
    description: z.string(),
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
  dtype: z.enum(['float16', 'float32', 'float64']),
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
    source: z.enum(['experiment', 'task']),
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
  data: kernelArtifactDataSpecSchema,
})

const kernelMaterialSchema = z
  .object({
    role: z.string(),
    description: z.string(),
    target: z
      .object({
        category: z.enum(['initializations', 'boundaryConditions', 'outputs']),
        methodId: z.string(),
      })
      .passthrough(),
    properties: z.record(z.string(), kernelParameterSchema),
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
    methods: z
      .object({
        initializations: z.array(kernelMethodSchema),
        boundaryConditions: z.array(kernelMethodSchema),
        outputs: z.array(kernelOutputMethodSchema),
      })
      .passthrough(),
  })
  .passthrough()

const quantityKindDetailSchema = quantityKindSchema.extend({
  materialParameters: z.array(
    z
      .object({
        key: z.string(),
        labelKo: z.string(),
      })
      .passthrough(),
  ),
  solverUsages: z.array(solverQuantityKindUsageSchema),
})

const materialParameterDetailSchema = materialParameterSchema.extend({
  quantityKindDefinition: quantityKindSchema,
  solverRequirements: z.array(solverMaterialRequirementSchema),
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
    materialParameterCount: nonnegativeIntegerSchema,
    materialModelCount: nonnegativeIntegerSchema,
    solverCount: nonnegativeIntegerSchema,
    experimentCount: nonnegativeIntegerSchema,
    materialGlobalQualifiers: z.array(z.string()),
    materialDesignRules: z.record(z.string(), z.string()),
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
    materialParameters: z.array(materialParameterSchema),
    materialModels: z.array(materialModelSchema),
    materialGlobalQualifiers: z.array(z.string()),
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

export function parseCatalogMaterialParameterList(value: unknown): CatalogList<CatalogMaterialParameter> {
  return parseCatalogList(value, materialParameterSchema)
}

export function parseCatalogMaterialParameterDetail(value: unknown): CatalogMaterialParameterDetail {
  return materialParameterDetailSchema.parse(value) as CatalogMaterialParameterDetail
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
