import { z } from 'zod'
import {
  cohortDiagnosticSchema,
  exclusionCountsSchema,
  predictionNeighborSchema,
  predictionTensorLayoutSchema,
  predictionTensorSampleSchema,
  queryDiagnosticSchema,
} from './protocolValidation'
import type { PredictionModelProfile } from './execution'
import type { RecordedDataRule } from '@/lib/cad/model'

const identity = z.string().min(1)
const count = z.number().int().nonnegative()
const direction = z.enum(['forward', 'inverse'])

export const remoteProfileSchema = z.object({
  direction,
  rowCount: count,
  inputLayouts: z.array(predictionTensorLayoutSchema),
  inputSize: count,
  outputSize: count,
  includedMeasurementIds: z.array(z.number().int().positive()),
  warningMeasurementIds: z.array(z.number().int().positive()),
  diagnostics: z.array(cohortDiagnosticSchema),
  omittedDiagnosticGroups: count,
  excluded: exclusionCountsSchema,
  knn: z
    .object({
      dominantShapeSignature: z.string(),
      baselineMeasurementId: z.number().int().positive(),
      k: z.number().int().positive(),
      weighting: z.enum(['uniform', 'distance']),
      inputScaling: z.enum(['range', 'standard-deviation']),
      inputScales: z.array(z.number().finite()).transform((values) => new Float64Array(values)),
      inputBlockWeights: z.record(z.string(), z.number().finite().nonnegative()),
      activeInputBlockCount: count,
    })
    .optional(),
  resources: z.object({ persistentBytes: count, workingSetBytes: count }).optional(),
})

export const remoteArtifactSchema = z
  .object({
    modelId: identity,
    revision: z.number().int().positive(),
    operationId: identity,
    name: identity,
    direction,
    algorithm: z.literal('knn'),
    definition: z.object({ fingerprint: identity }).passthrough(),
    datasetId: identity,
    datasetRevision: z.number().int().positive(),
    datasetFingerprint: identity,
    storageId: identity,
    launcherId: identity,
    manifestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    formatVersion: z.literal(1),
    files: z.array(z.object({ name: identity, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: count })),
    profile: remoteProfileSchema,
    inputLayouts: z.array(predictionTensorLayoutSchema),
    outputLayouts: z.array(predictionTensorLayoutSchema),
  })
  .passthrough()
export type RemoteArtifact = z.infer<typeof remoteArtifactSchema>

export const remoteDatasetSchema = z
  .object({
    datasetId: identity,
    revision: z.number().int().positive(),
    fingerprint: identity,
  })
  .passthrough()

const unavailableErrorSchema = z.object({ code: identity, message: identity }).transform((error) => error.message)
const unavailableModelSchema = z.object({
  modelId: identity,
  revision: z.number().int().positive(),
  available: z.literal(false),
  error: unavailableErrorSchema,
})
const unavailableDatasetSchema = z.object({
  datasetId: identity,
  revision: z.number().int().positive(),
  available: z.literal(false),
  error: unavailableErrorSchema,
})

export const remoteHelloSchema = z.object({
  sessionId: identity,
  storageId: identity,
  launcherId: identity,
  implementationVersion: identity,
  preprocessingVersion: identity,
  capabilities: z.unknown(),
  datasets: z.array(z.union([unavailableDatasetSchema, remoteDatasetSchema])),
  models: z.array(z.union([unavailableModelSchema, remoteArtifactSchema])),
})
export type RemoteHello = z.infer<typeof remoteHelloSchema>

export const remotePreparedSchema = z.object({
  fingerprint: identity,
  instance: z.object({
    executionId: z.literal('remote-knn'),
    sessionId: identity,
    generation: count,
    handle: identity,
  }),
  profile: remoteProfileSchema,
  errors: z.record(z.string(), z.string()),
  recordProfiles: z.array(
    z.object({
      recordId: z.number().int().positive(),
      name: identity,
      error: z.string().nullable(),
      profile: remoteProfileSchema.nullable(),
    }),
  ),
  rules: z
    .array(z.object({ label: identity }).passthrough())
    .transform((rules) => rules as unknown as readonly RecordedDataRule[]),
  artifact: remoteArtifactSchema,
})
export type RemotePrepared = z.infer<typeof remotePreparedSchema>

export const remoteResultSchema = z.object({
  direction,
  fingerprint: identity,
  output: z.array(predictionTensorSampleSchema),
  extrapolatedInputKeys: z.array(z.string()),
  constantInputKeysChanged: z.array(z.string()),
  queryDiagnostics: z.array(queryDiagnosticSchema),
  knn: z.object({ neighbors: z.array(predictionNeighborSchema) }).optional(),
  provenance: z.object({
    modelId: identity,
    modelRevision: z.number().int().positive(),
    datasetId: identity,
    datasetRevision: z.number().int().positive(),
  }),
})

export class RemotePredictionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RemotePredictionError'
  }
}

export function parseRemoteEnvelope(value: unknown, requestId: string, sessionId?: string) {
  if (value && typeof value === 'object' && 'protocolVersion' in value && value.protocolVersion !== 2)
    throw new RemotePredictionError(
      'unsupported-execution',
      'Predictor 통신 버전이 다릅니다. API·UI와 같은 릴리스로 Predictor를 업데이트하고 launcher를 다시 연결하세요.',
    )
  const envelope = z
    .object({
      protocolVersion: z.literal(2),
      requestId: identity,
      sessionId: identity,
      error: z.object({ code: identity, message: identity }).optional(),
    })
    .passthrough()
    .parse(value)
  if (envelope.requestId !== requestId || (sessionId && envelope.sessionId !== sessionId))
    throw new RemotePredictionError('stale-response', '이전 Prediction 세션 또는 요청의 응답입니다.')
  if (envelope.error) throw new RemotePredictionError(envelope.error.code, envelope.error.message)
  return envelope
}

/** Typed arrays are local; registered metadata uses portable JSON arrays. */
export function profileJson(profile: PredictionModelProfile) {
  return {
    ...profile,
    ...(profile.knn ? { knn: { ...profile.knn, inputScales: Array.from(profile.knn.inputScales) } } : {}),
  }
}
