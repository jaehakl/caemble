import { z } from 'zod'

export const BUILD_VERSION = '2' as const
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
export const artifactItemSchema = z.object({
  index: z.number().int().positive(),
  file: z.string().regex(/^items\/[1-9][0-9]*\.json$/),
  input_hash: z.string().regex(/^[a-f0-9]{64}$/),
  byte_length: z.number().int().positive(),
  measurement_id: z.number().int().positive().optional(),
})
export const buildArtifactSchema = z.object({
  kind: z.literal('caemble.build'),
  version: z.literal(2),
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  catalog_revision: z.string().min(1),
  builder_version: z.literal(BUILD_VERSION),
  mode: z.enum(['generate', 'candidate', 'measurement']),
  source_bundle: z.object({ files: z.record(z.string(), z.string()) }),
  items: z.array(artifactItemSchema).min(1),
})
export type BuildArtifact = z.infer<typeof buildArtifactSchema>
export type BuildArtifactItem = z.infer<typeof artifactItemSchema>
