import { z } from 'zod'
import type { KernelDescriptor } from '@/lib/cad/simulation'

export const quantityKindSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1),
  tensorOrder: z.number().int().nonnegative(),
  description: z.string().nullable().optional(),
  opaque: z.boolean(),
  applicableUnits: z.array(z.string()),
})

export const materialParameterSchema = z.object({
  key: z.string().min(1),
  domain: z.string().min(1),
  labelKo: z.string(),
  quantityKind: z.string().min(1),
  specialQualifiers: z.array(z.string()),
})

export const materialModelSchema = z.object({
  key: z.string().min(1),
  labelKo: z.string(),
  kind: z.literal('sampled_relation'),
  input: z.object({ name: z.string(), quantityKind: z.string() }),
  output: z.object({ name: z.string(), quantityKind: z.string() }),
  minimumSamples: z.number().int().min(2),
  sharedBasis: z.boolean(),
})

export const solverListItemSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

const dataAxisSchema = z.object({
  length: z.number().int().nonnegative().optional(),
  name: z.string().optional(),
  ticks: z.array(z.union([z.number(), z.string()])).optional(),
  unit: z.string().optional(),
  quantityKind: z.string().optional(),
})

const valueSpecSchema = z.object({
  dtype: z.enum([
    'bool',
    'string',
    'int8',
    'int16',
    'int32',
    'int64',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'float16',
    'float32',
    'float64',
  ]),
  unit: z.string().optional(),
  quantityKind: z.string().optional(),
  basis: z
    .array(z.tuple([z.number(), z.number(), z.number()]))
    .length(3)
    .optional(),
  axes: z.array(dataAxisSchema).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.boolean().optional(),
  exclusiveMaximum: z.boolean().optional(),
  values: z.array(z.string()).optional(),
  minimumLength: z.number().int().nonnegative().optional(),
})

const parameterSchema = z.object({
  description: z.string(),
  required: z.boolean().optional(),
  data: valueSpecSchema,
})

const targetSchema = z.object({
  source: z.enum(['experiment', 'task']),
  kind: z.enum(['geometry', 'surface']),
  minimumTargets: z.number().int().nonnegative(),
  maximumTargets: z.number().int().nonnegative(),
  minimumResolved: z.number().int().nonnegative(),
  maximumResolved: z.number().int().nonnegative(),
})

const methodSchema = z.object({
  methodId: z.string().min(1),
  description: z.string(),
  minimumOccurrences: z.number().int().nonnegative(),
  maximumOccurrences: z.number().int().nonnegative(),
  target: targetSchema,
  parameters: z.record(z.string(), parameterSchema),
})

const outputMethodSchema = methodSchema.extend({
  artifactType: z.string().regex(/^.+@\d+$/),
  data: valueSpecSchema,
})

const solverDescriptorShapeSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  referenceLengthUnit: z.string().min(1),
  minimumOutputs: z.number().int().nonnegative().optional(),
  parameters: z.record(z.string(), parameterSchema),
  materials: z.array(
    z.object({
      role: z.string().min(1),
      description: z.string(),
      target: z.object({
        category: z.enum(['initializations', 'boundaryConditions', 'outputs']),
        methodId: z.string().min(1),
      }),
      properties: z.record(z.string(), parameterSchema),
    }),
  ),
  inputPorts: z.record(
    z.string(),
    z.object({
      description: z.string(),
      artifactTypes: z.array(z.string().regex(/^.+@\d+$/)),
      minimumOccurrences: z.number().int().nonnegative(),
      maximumOccurrences: z.number().int().nonnegative(),
      data: valueSpecSchema.optional(),
    }),
  ),
  observations: z.record(
    z.string(),
    z.object({
      description: z.string(),
      type: z.enum(['number', 'boolean', 'string']),
      required: z.boolean().optional(),
    }),
  ),
  methods: z.object({
    initializations: z.array(methodSchema),
    boundaryConditions: z.array(methodSchema),
    outputs: z.array(outputMethodSchema),
  }),
})

export const solverDescriptorSchema = solverDescriptorShapeSchema as z.ZodType<KernelDescriptor>

const quantityKindUsageSchema = z.object({
  solverName: z.string(),
  solverVersion: z.string(),
  context: z.string(),
  path: z.string(),
  unit: z.string().nullable().optional(),
})

const materialRequirementSchema = z.object({
  solverName: z.string(),
  solverVersion: z.string(),
  role: z.string(),
  methodCategory: z.string(),
  methodId: z.string(),
  description: z.string(),
})

export const catalogMetaSchema = z.object({
  schemaVersion: z.literal(5),
  catalogRevision: z.string().min(1),
  quantityKindCount: z.number().int().nonnegative(),
  materialParameterCount: z.number().int().nonnegative(),
  materialModelCount: z.number().int().nonnegative(),
  solverCount: z.number().int().nonnegative(),
  experimentCount: z.number().int().nonnegative(),
  materialGlobalQualifiers: z.array(z.string()),
  materialDesignRules: z.record(z.string(), z.string()),
})

export const quantityKindDetailSchema = quantityKindSchema.extend({
  materialParameters: z.array(z.object({ key: z.string(), labelKo: z.string() })),
  solverUsages: z.array(quantityKindUsageSchema),
})

export const materialParameterDetailSchema = materialParameterSchema.extend({
  quantityKindDefinition: quantityKindSchema,
  solverRequirements: z.array(materialRequirementSchema),
})

export const solverDetailSchema = solverListItemSchema.extend({
  descriptor: solverDescriptorSchema,
  materialRequirements: z.array(
    z.object({
      solverName: z.string(),
      solverVersion: z.string(),
      role: z.string(),
      roleDescription: z.string().nullable(),
      methodCategory: z.string(),
      methodId: z.string(),
      materialParameter: z.string().nullable(),
      description: z.string(),
      quantityKind: z.string().nullable(),
      unit: z.string().nullable(),
    }),
  ),
  quantityKindUsages: z.array(
    z.object({
      solverName: z.string(),
      solverVersion: z.string(),
      quantityKind: z.string(),
      context: z.string(),
      path: z.string(),
      unit: z.string().nullable().optional(),
    }),
  ),
  producesArtifacts: z.array(
    z.object({
      methodId: z.string(),
      artifactType: z.string(),
      consumers: z.array(z.object({ solverName: z.string(), solverVersion: z.string(), inputPort: z.string() })),
    }),
  ),
  consumesArtifacts: z.array(
    z.object({
      inputPort: z.string(),
      artifactType: z.string(),
      producers: z.array(z.object({ solverName: z.string(), solverVersion: z.string(), methodId: z.string() })),
    }),
  ),
})

const experimentSolverSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
})

export const experimentListItemSchema = z.object({
  key: z.string().min(1),
  namespace: z.string().min(1),
  repository: z.string().min(1),
  version: z.string().regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/),
  coordinate: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  cadApiVersion: z.literal(9),
  sourceFormatVersion: z.literal(2),
  bundleFormatVersion: z.literal(6),
  bundleHash: z.string().regex(/^[0-9a-f]{64}$/),
  concepts: z.array(z.string()),
  relatedSolvers: z.array(experimentSolverSchema),
})

const experimentSourceBundleSchema = z.object({
  formatVersion: z.literal(6),
  files: z.record(z.string(), z.string()),
})

const verificationRecordSchema = z.object({
  name: z.string().min(1),
  dtype: z.string().min(1),
  shape: z.array(z.number().int().nonnegative()),
})

const exactVerificationRecordSchema = verificationRecordSchema
  .extend({
    value: z.unknown(),
    absoluteTolerance: z.number().finite().nonnegative(),
  })
  .strict()
  .refine((record) => Object.prototype.hasOwnProperty.call(record, 'value'), {
    message: 'Exact verification records require value.',
  })

const assertionVerificationRecordSchema = verificationRecordSchema
  .extend({
    finite: z.literal(true).optional(),
    nonzero: z.literal(true).optional(),
    minimumExclusive: z.number().finite().optional(),
  })
  .strict()
  .refine((record) => record.finite === true || record.nonzero === true || record.minimumExclusive !== undefined, {
    message: 'Assertion verification records require at least one assertion.',
  })

const experimentVerificationSchema = z.object({
  kernelTasks: z.array(z.string()),
  recordedData: z.array(z.string()),
  expectations: z.array(z.string()),
  fixture: z
    .object({
      records: z.array(z.union([exactVerificationRecordSchema, assertionVerificationRecordSchema])),
      terminal: z
        .object({
          kind: z.literal('complete'),
          sequence: z.number().int().nonnegative(),
          recordSequences: z.array(z.number().int().nonnegative()),
        })
        .strict(),
    })
    .strict()
    .nullable()
    .optional(),
})

export const experimentDetailSchema = experimentListItemSchema.extend({
  sourceBundle: experimentSourceBundleSchema,
  verification: experimentVerificationSchema,
})

export const searchItemSchema = z.object({
  kind: z.enum(['quantityKind', 'materialParameter', 'materialModel', 'solver', 'experiment']),
  key: z.string(),
  title: z.string(),
  subtitle: z.string(),
})

const runtimeSolverSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
    descriptor: solverDescriptorSchema,
  })
  .superRefine((solver, context) => {
    if (solver.descriptor.name !== solver.name || solver.descriptor.version !== solver.version) {
      context.addIssue({ code: 'custom', message: 'Solver descriptor identity must match its catalog identity.' })
    }
  })

export const runtimeSliceSchema = z.object({
  schemaVersion: z.literal(1),
  catalogRevision: z.string().min(1),
  solvers: z.array(runtimeSolverSchema),
  quantityKinds: z.array(quantityKindSchema),
  materialParameters: z.array(materialParameterSchema),
  materialModels: z.array(materialModelSchema),
  materialGlobalQualifiers: z.array(z.string()),
  warnings: z.array(z.string()),
})

export type ListQuery = Readonly<{
  q?: string
  domain?: string
  solverName?: string
  solverVersion?: string
  usage?: string
  unit?: string
  tensorOrder?: number
  quantityKind?: string
  namespace?: string
  repository?: string
  version?: string
  limit?: number
  cursor?: string
}>

export function listSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable(), total: z.number().int().nonnegative() })
}

export function parseCatalogRuntimeSlice(value: unknown) {
  return runtimeSliceSchema.parse(value)
}

export type CatalogMeta = z.infer<typeof catalogMetaSchema>
export type CatalogQuantityKind = z.infer<typeof quantityKindSchema>
export type CatalogQuantityKindDetail = z.infer<typeof quantityKindDetailSchema>
export type CatalogMaterialParameter = z.infer<typeof materialParameterSchema>
export type CatalogMaterialParameterDetail = z.infer<typeof materialParameterDetailSchema>
export type CatalogMaterialModel = z.infer<typeof materialModelSchema>
export type CatalogSolverListItem = z.infer<typeof solverListItemSchema>
export type CatalogSolverDetail = z.infer<typeof solverDetailSchema>
export type CatalogExperimentListItem = z.infer<typeof experimentListItemSchema>
export type CatalogExperimentDetail = z.infer<typeof experimentDetailSchema>
export type CatalogSearchItem = z.infer<typeof searchItemSchema>
export type CatalogRuntimeSlice = z.infer<typeof runtimeSliceSchema>
export type CatalogRuntimeSliceRequest = Readonly<{
  solvers: readonly Readonly<{ name: string; version: string }>[]
  quantityKinds: readonly string[]
  materialParameters: readonly string[]
  materialModels: readonly string[]
}>
