import { z } from 'zod'
import type { MeasurementVisualization, RecordedResultContracts, ResultProvenance } from './results'

export const resultVisualizationSchema = z
  .object({
    kind: z.enum([
      'tensor',
      'bundle',
      'mesh-field',
      'mesh-transform',
      'structured-field',
      'polyline',
      'box-grid',
      'particle-set',
    ]),
    coordinateSpace: z.literal('experiment').optional(),
    configuration: z.enum(['reference', 'current']).optional(),
    sampling: z.literal('cell-average').optional(),
    weighting: z.literal('reference-volume').optional(),
    signConvention: z.literal('compression-positive').optional(),
    particleSet: z
      .object({
        positions: z.string().min(1),
        particleIds: z.string().min(1),
        materialIndices: z.string().min(1),
        materialNames: z.string().min(1),
        times: z.string().min(1),
        attributes: z.record(
          z.string(),
          z
            .object({
              path: z.string().min(1),
              components: z.array(z.string().min(1)).optional(),
              rowConfiguration: z.literal('current').optional(),
              columnConfiguration: z.literal('reference').optional(),
            })
            .strict(),
        ),
        radius: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    meshTransform: z
      .object({
        bodyIds: z.string().min(1),
        vertices: z.string().min(1),
        triangles: z.string().min(1),
        vertexOffsets: z.string().min(1),
        triangleOffsets: z.string().min(1),
        localCenters: z.string().min(1),
        times: z.string().min(1),
        positions: z.string().min(1),
        orientations: z.string().min(1),
        quaternionOrder: z.literal('wxyz'),
      })
      .strict()
      .optional(),
    valuePath: z.string().optional(),
    fieldPath: z.string().optional(),
    nodeIdsPath: z.string().optional(),
    time: z
      .object({
        path: z.string(),
        axis: z.number().int().nonnegative(),
        nodeAxis: z.number().int().nonnegative(),
        componentAxis: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    frequency: z
      .object({
        path: z.string(),
        axis: z.number().int().nonnegative(),
        entityAxis: z.number().int().nonnegative(),
        componentAxis: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    phasor: z
      .object({ timeConvention: z.literal('exp(+i*omega*t)'), amplitude: z.literal('peak') })
      .strict()
      .optional(),
    grid: z
      .object({
        xyzAxes: z.tuple([
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
          z.number().int().nonnegative(),
        ]),
        sampleAxis: z.number().int().nonnegative(),
        sampleKind: z.enum(['frequency', 'time']),
        componentAxis: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    spatialAxes: z.array(z.number().int().nonnegative()).optional(),
    components: z.array(z.string()).optional(),
    valueKind: z.enum(['displacement', 'stress', 'scalar', 'vector']).optional(),
    vertices: z.string().optional(),
    offsets: z.string().optional(),
    attributes: z
      .record(z.string(), z.object({ path: z.string(), association: z.enum(['path', 'segment']) }))
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.kind === 'particle-set') !== Boolean(value.particleSet))
      context.addIssue({
        code: 'custom',
        message: 'Particle visualization requires explicit coordinate, identity and quantity paths.',
      })
    if ((value.kind === 'mesh-transform') !== Boolean(value.meshTransform))
      context.addIssue({ code: 'custom', message: 'Mesh transforms require their explicit mesh and pose paths.' })
    if (Boolean(value.frequency) !== Boolean(value.phasor) || (value.frequency && value.time))
      context.addIssue({
        code: 'custom',
        message: 'Harmonic visualization requires frequency and phasor semantics without a time history.',
      })
    if (
      value.frequency &&
      (value.kind !== 'mesh-field' ||
        new Set([value.frequency.axis, value.frequency.entityAxis, value.frequency.componentAxis]).size !== 3)
    )
      context.addIssue({
        code: 'custom',
        message: 'Harmonic mesh axes must identify distinct frequency, entity and component dimensions.',
      })
  })

export const recordedResultContractsSchema: z.ZodType<RecordedResultContracts> = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u),
  z
    .object({
      task: z.string().min(1),
      output: z.string().min(1),
      solver: z.object({ name: z.string().min(1), version: z.string().min(1) }),
      artifactType: z.string().min(1),
      catalogRevision: z.string().min(1),
      schema: z.record(z.string(), z.unknown()),
      visualization: resultVisualizationSchema,
    })
    .strict(),
)

export const resultProvenanceSchema: z.ZodType<ResultProvenance> = z
  .object({
    task: z.string().min(1),
    solver: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
    stateRevision: z.number().int().nonnegative(),
    invocation: z.number().int().positive(),
    catalogRevision: z.string().min(1),
  })
  .strict()

export const measurementVisualizationSchema: z.ZodType<MeasurementVisualization> = z
  .object({
    contract: z.object({ artifactType: z.string().min(1), visualization: resultVisualizationSchema }).strict(),
    schema: z.record(z.string(), z.unknown()),
    data: z.unknown(),
    provenance: resultProvenanceSchema,
  })
  .strict()
