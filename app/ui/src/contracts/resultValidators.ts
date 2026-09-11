import { z } from 'zod'
import type { RecordedResultContracts } from './results'

export const resultVisualizationSchema = z
  .object({
    kind: z.enum(['tensor', 'bundle', 'mesh-field', 'structured-field', 'polyline']),
    coordinateSpace: z.literal('experiment').optional(),
    valuePath: z.string().optional(),
    spatialAxes: z.array(z.number().int().nonnegative()).optional(),
    components: z.array(z.string()).optional(),
    valueKind: z.enum(['displacement', 'stress']).optional(),
    vertices: z.string().optional(),
    offsets: z.string().optional(),
    attributes: z
      .record(z.string(), z.object({ path: z.string(), association: z.enum(['path', 'segment']) }))
      .optional(),
  })
  .strict()

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
