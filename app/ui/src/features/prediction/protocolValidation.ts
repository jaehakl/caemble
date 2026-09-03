import { z } from 'zod'
import { predictionNumericDtypes } from './knn'
import type { PredictionWorkerRequest, PredictionWorkerResponse } from './protocol'

const nonnegativeIntegerSchema = z.number().int().nonnegative()
const positiveIntegerSchema = z.number().int().positive()
const nonBlankStringSchema = z.string().refine((value) => value.trim().length > 0, 'Expected a non-empty string.')

function isFiniteNumberArray(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (typeof value[index] !== 'number' || !Number.isFinite(value[index])) return false
  }
  return true
}

const finiteNumberArraySchema = z.custom<readonly number[]>(isFiniteNumberArray, 'Expected an array of finite numbers.')
const float64ArraySchema = z.custom<Float64Array>(
  (value) => value instanceof Float64Array && value.every((item) => Number.isFinite(item)),
  'Expected a Float64Array containing finite numbers.',
)

const predictionAxisSchema = z
  .object({
    name: nonBlankStringSchema,
    ticks: z.array(z.union([z.number(), z.string()])),
    unit: nonBlankStringSchema.optional(),
  })
  .passthrough()

const predictionTensorLayoutSchema = z
  .object({
    key: nonBlankStringSchema,
    dtype: z.enum(predictionNumericDtypes),
    shape: z.array(nonnegativeIntegerSchema),
    axes: z.array(predictionAxisSchema).optional(),
    dataSchemaSignature: nonBlankStringSchema.optional(),
    tensorOrder: nonnegativeIntegerSchema.optional(),
    unit: nonBlankStringSchema.optional(),
    quantityKind: nonBlankStringSchema.optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .passthrough()
  .superRefine((layout, context) => {
    const tensorOrder = layout.tensorOrder ?? 0
    if (tensorOrder > layout.shape.length) {
      context.addIssue({
        code: 'custom',
        path: ['tensorOrder'],
        message: 'Tensor order must not exceed the shape rank.',
      })
    }
    if ((layout.minimum === undefined) !== (layout.maximum === undefined)) {
      context.addIssue({ code: 'custom', path: ['minimum'], message: 'Tensor bounds must be provided together.' })
    } else if (layout.minimum !== undefined && layout.maximum !== undefined && layout.minimum > layout.maximum) {
      context.addIssue({
        code: 'custom',
        path: ['minimum'],
        message: 'Tensor minimum must not exceed its maximum.',
      })
    }
    const externalRank = Math.max(0, layout.shape.length - tensorOrder)
    if (layout.axes !== undefined && layout.axes.length !== externalRank) {
      context.addIssue({ code: 'custom', path: ['axes'], message: 'Tensor axes must match the external shape rank.' })
      return
    }
    layout.axes?.forEach((axis, index) => {
      if (axis.ticks.length !== layout.shape[index]) {
        context.addIssue({
          code: 'custom',
          path: ['axes', index, 'ticks'],
          message: 'Axis ticks must match the corresponding shape dimension.',
        })
      }
    })
  })

const predictionTensorSampleSchema = z
  .object({
    layout: predictionTensorLayoutSchema,
    values: finiteNumberArraySchema,
  })
  .passthrough()
  .superRefine((sample, context) => {
    let size = 1
    for (const length of sample.layout.shape) {
      if (!Number.isSafeInteger(size * length)) {
        context.addIssue({ code: 'custom', path: ['layout', 'shape'], message: 'Tensor shape is too large.' })
        return
      }
      size *= length
    }
    if (sample.values.length !== size) {
      context.addIssue({
        code: 'custom',
        path: ['values'],
        message: 'Tensor values must match the declared shape.',
      })
    }
  })

const predictionTrainingRowSchema = z
  .object({
    measurementId: positiveIntegerSchema,
    inputs: z.array(predictionTensorSampleSchema),
    outputs: z.array(predictionTensorSampleSchema),
  })
  .passthrough()

const exclusionReasonSchema = z.enum([
  'missing-block',
  'extra-block',
  'invalid-tensor',
  'fixed-layout-mismatch',
  'layout-mismatch',
])

const cohortDiagnosticSchema = z
  .object({
    direction: z.enum(['forward', 'inverse']),
    disposition: z.enum(['included-with-warning', 'excluded']),
    reason: z.union([exclusionReasonSchema, z.literal('metadata-mismatch')]),
    side: z.enum(['input', 'output']),
    blockKey: z.string(),
    fieldPath: z.string(),
    baselineMeasurementId: positiveIntegerSchema.nullable(),
    expected: z.string(),
    actual: z.string(),
    measurementIds: z.array(positiveIntegerSchema),
    mismatchCount: nonnegativeIntegerSchema.optional(),
    firstMismatchIndex: nonnegativeIntegerSchema.optional(),
    maxAbsoluteDifference: z.number().nonnegative().optional(),
  })
  .passthrough()

const exclusionCountsSchema = z
  .object({
    'missing-block': nonnegativeIntegerSchema,
    'extra-block': nonnegativeIntegerSchema,
    'invalid-tensor': nonnegativeIntegerSchema,
    'fixed-layout-mismatch': nonnegativeIntegerSchema,
    'layout-mismatch': nonnegativeIntegerSchema,
  })
  .passthrough()

const dominantShapeSignatureValueSchema = z.array(
  z.object({ key: nonBlankStringSchema, shape: z.array(nonnegativeIntegerSchema) }).passthrough(),
)
const dominantShapeSignatureSchema = nonBlankStringSchema.superRefine((value, context) => {
  try {
    const parsed = dominantShapeSignatureValueSchema.safeParse(JSON.parse(value))
    if (!parsed.success) throw parsed.error
  } catch {
    context.addIssue({ code: 'custom', message: 'Dominant shape signature must contain a valid tensor shape list.' })
  }
})

const cohortOptionsSchema = z
  .object({
    direction: z.enum(['forward', 'inverse']),
    fingerprint: nonBlankStringSchema,
    k: positiveIntegerSchema.optional(),
    weighting: z.enum(['uniform', 'distance']).optional(),
    inputScaling: z.enum(['range', 'standard-deviation']).optional(),
    inputBlockWeights: z.record(z.string(), z.number().nonnegative()).optional(),
    outputDtypes: z.record(z.string(), z.enum(predictionNumericDtypes)).optional(),
    inputKeys: z.array(nonBlankStringSchema),
    outputKeys: z.array(nonBlankStringSchema),
    rows: z.array(predictionTrainingRowSchema),
    diagnoseMetadata: z.boolean().optional(),
    fixedInputLayouts: z.array(predictionTensorLayoutSchema).optional(),
    fixedOutputLayouts: z.array(predictionTensorLayoutSchema).optional(),
    persistentArrayLimitBytes: positiveIntegerSchema.optional(),
    workingSetLimitBytes: positiveIntegerSchema.optional(),
  })
  .passthrough()

const samplingRangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .passthrough()
  .refine(({ max, min }) => min <= max, 'Sampling range minimum must not exceed its maximum.')

const samplingOptionsSchema = z
  .object({
    fingerprint: nonBlankStringSchema,
    totalAttempts: positiveIntegerSchema,
    layouts: z.array(predictionTensorLayoutSchema),
    ranges: z.record(z.string(), samplingRangeSchema),
    centers: z.array(z.array(predictionTensorSampleSchema)),
  })
  .passthrough()

const workerIdentityFields = {
  requestId: nonBlankStringSchema,
  modelId: nonBlankStringSchema,
  generation: nonnegativeIntegerSchema,
  fingerprint: nonBlankStringSchema,
}
const requestIdFields = { requestId: nonBlankStringSchema }

const predictionWorkerRequestSchema = z.discriminatedUnion('type', [
  z.object({ ...workerIdentityFields, type: z.literal('build-model'), options: cohortOptionsSchema }).passthrough(),
  z
    .object({ ...workerIdentityFields, type: z.literal('predict'), query: z.array(predictionTensorSampleSchema) })
    .passthrough(),
  z.object({ ...workerIdentityFields, type: z.literal('drop-model') }).passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('start-sampling'),
      sessionId: nonBlankStringSchema,
      options: samplingOptionsSchema,
    })
    .passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('next-sample'),
      sessionId: nonBlankStringSchema,
      fingerprint: nonBlankStringSchema,
      attempt: positiveIntegerSchema,
    })
    .passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('accept-sample'),
      sessionId: nonBlankStringSchema,
      fingerprint: nonBlankStringSchema,
      sample: z.array(predictionTensorSampleSchema),
    })
    .passthrough(),
  z.object({ ...requestIdFields, type: z.literal('drop-sampling'), sessionId: nonBlankStringSchema }).passthrough(),
  z.object({ ...requestIdFields, type: z.literal('dispose') }).passthrough(),
])

const workerModelProfileSchema = z
  .object({
    direction: z.enum(['forward', 'inverse']),
    activeInputBlockCount: nonnegativeIntegerSchema,
    rowCount: positiveIntegerSchema,
    k: positiveIntegerSchema,
    weighting: z.enum(['uniform', 'distance']),
    inputScaling: z.enum(['range', 'standard-deviation']),
    inputLayouts: z.array(predictionTensorLayoutSchema),
    inputScales: float64ArraySchema,
    inputBlockWeights: z.record(z.string(), z.number().nonnegative()),
    inputSize: positiveIntegerSchema,
    outputSize: positiveIntegerSchema,
    persistentBytes: nonnegativeIntegerSchema,
    workingSetBytes: nonnegativeIntegerSchema,
    includedMeasurementIds: z.array(positiveIntegerSchema),
    warningMeasurementIds: z.array(positiveIntegerSchema),
    dominantShapeSignature: dominantShapeSignatureSchema,
    baselineMeasurementId: positiveIntegerSchema,
    diagnostics: z.array(cohortDiagnosticSchema),
    omittedDiagnosticGroups: nonnegativeIntegerSchema,
    excluded: exclusionCountsSchema,
  })
  .passthrough()
  .superRefine((profile, context) => {
    const expectedScaleCount = profile.direction === 'inverse' ? profile.inputSize : 0
    if (profile.inputScales.length !== expectedScaleCount) {
      context.addIssue({
        code: 'custom',
        path: ['inputScales'],
        message: 'Model input scales must match the active direction and input size.',
      })
    }
  })

const predictionNeighborSchema = z
  .object({
    measurementId: positiveIntegerSchema,
    distanceSquared: z.number().nonnegative(),
    weight: z.number().nonnegative(),
  })
  .passthrough()

const queryDiagnosticSchema = z
  .object({
    blockKey: z.string(),
    fieldPath: z.string(),
    expected: z.string(),
    actual: z.string(),
    mismatchCount: nonnegativeIntegerSchema.optional(),
    firstMismatchIndex: nonnegativeIntegerSchema.optional(),
    maxAbsoluteDifference: z.number().nonnegative().optional(),
  })
  .passthrough()

const predictionResultSchema = z
  .object({
    direction: z.enum(['forward', 'inverse']),
    fingerprint: z.string(),
    output: z.array(predictionTensorSampleSchema),
    neighbors: z.array(predictionNeighborSchema),
    extrapolatedInputKeys: z.array(z.string()),
    constantInputKeysChanged: z.array(z.string()),
    queryDiagnostics: z.array(queryDiagnosticSchema),
  })
  .passthrough()

const samplingProfileSchema = z
  .object({
    activeBlockCount: positiveIntegerSchema,
    activeComponentCount: positiveIntegerSchema,
    existingCenterCount: nonnegativeIntegerSchema,
    candidateCount: positiveIntegerSchema,
  })
  .passthrough()

const errorResponseSchema = z
  .object({
    ...requestIdFields,
    type: z.literal('error'),
    modelId: nonBlankStringSchema.optional(),
    generation: nonnegativeIntegerSchema.optional(),
    fingerprint: nonBlankStringSchema.optional(),
    code: nonBlankStringSchema,
    message: nonBlankStringSchema,
  })
  .passthrough()

const predictionWorkerResponseSchema = z.discriminatedUnion('type', [
  z
    .object({ ...workerIdentityFields, type: z.literal('model-ready'), profile: workerModelProfileSchema })
    .passthrough(),
  z.object({ ...workerIdentityFields, type: z.literal('prediction'), result: predictionResultSchema }).passthrough(),
  z.object({ ...workerIdentityFields, type: z.literal('model-dropped') }).passthrough(),
  z.object({ ...workerIdentityFields, type: z.literal('stale') }).passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('sampling-ready'),
      sessionId: nonBlankStringSchema,
      fingerprint: nonBlankStringSchema,
      profile: samplingProfileSchema,
    })
    .passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('sampling-candidate'),
      sessionId: nonBlankStringSchema,
      fingerprint: nonBlankStringSchema,
      sample: z.array(predictionTensorSampleSchema),
    })
    .passthrough(),
  z
    .object({
      ...requestIdFields,
      type: z.literal('sampling-accepted'),
      sessionId: nonBlankStringSchema,
      fingerprint: nonBlankStringSchema,
      centerCount: positiveIntegerSchema,
    })
    .passthrough(),
  z.object({ ...requestIdFields, type: z.literal('sampling-dropped'), sessionId: nonBlankStringSchema }).passthrough(),
  errorResponseSchema,
  z.object({ ...requestIdFields, type: z.literal('disposed') }).passthrough(),
])

const requestIdSchema = z.object({ requestId: nonBlankStringSchema })

function assertModelIdentity(response: PredictionWorkerResponse, request: PredictionWorkerRequest) {
  if (
    !('modelId' in response) ||
    !('modelId' in request) ||
    response.modelId !== request.modelId ||
    response.generation !== request.generation ||
    response.fingerprint !== request.fingerprint
  ) {
    throw new TypeError('Prediction Worker response model identity does not match its request.')
  }
}

function assertSamplingIdentity(
  response: Extract<PredictionWorkerResponse, Readonly<{ sessionId: string }>>,
  request: Extract<PredictionWorkerRequest, Readonly<{ sessionId: string }>>,
) {
  if (response.sessionId !== request.sessionId) {
    throw new TypeError('Prediction Worker response sampling session does not match its request.')
  }
  if ('fingerprint' in response) {
    const expected =
      request.type === 'start-sampling'
        ? request.options.fingerprint
        : 'fingerprint' in request
          ? request.fingerprint
          : null
    if (expected === null || response.fingerprint !== expected) {
      throw new TypeError('Prediction Worker response sampling fingerprint does not match its request.')
    }
  }
}

export function predictionWorkerMessageRequestId(value: unknown): string | null {
  const parsed = requestIdSchema.safeParse(value)
  return parsed.success ? parsed.data.requestId : null
}

export function parsePredictionWorkerRequest(value: unknown): PredictionWorkerRequest {
  return predictionWorkerRequestSchema.parse(value) as PredictionWorkerRequest
}

export function parsePredictionWorkerResponse(value: unknown): PredictionWorkerResponse {
  const response = predictionWorkerResponseSchema.parse(value) as PredictionWorkerResponse
  if (response.type === 'prediction' && response.result.fingerprint !== response.fingerprint) {
    throw new TypeError('Prediction Worker result fingerprint does not match its response identity.')
  }
  return response
}

export function parsePredictionWorkerResponseForRequest(
  value: unknown,
  request: PredictionWorkerRequest,
): PredictionWorkerResponse {
  const response = parsePredictionWorkerResponse(value)
  if (response.requestId !== request.requestId) {
    throw new TypeError('Prediction Worker response requestId does not match its request.')
  }
  if (response.type === 'error') {
    if ('modelId' in request) {
      if (response.modelId !== undefined && response.modelId !== request.modelId) {
        throw new TypeError('Prediction Worker error modelId does not match its request.')
      }
      if (response.generation !== undefined && response.generation !== request.generation) {
        throw new TypeError('Prediction Worker error generation does not match its request.')
      }
      if (response.fingerprint !== undefined && response.fingerprint !== request.fingerprint) {
        throw new TypeError('Prediction Worker error fingerprint does not match its request.')
      }
    }
    return response
  }

  switch (request.type) {
    case 'build-model':
      if (response.type !== 'model-ready' && response.type !== 'stale') break
      assertModelIdentity(response, request)
      if (response.type === 'model-ready' && response.profile.direction !== request.options.direction) break
      return response
    case 'predict':
      if (response.type !== 'prediction' && response.type !== 'stale') break
      assertModelIdentity(response, request)
      return response
    case 'drop-model':
      if (response.type !== 'model-dropped' && response.type !== 'stale') break
      assertModelIdentity(response, request)
      return response
    case 'start-sampling':
      if (response.type !== 'sampling-ready') break
      assertSamplingIdentity(response, request)
      return response
    case 'next-sample':
      if (response.type !== 'sampling-candidate') break
      assertSamplingIdentity(response, request)
      return response
    case 'accept-sample':
      if (response.type !== 'sampling-accepted') break
      assertSamplingIdentity(response, request)
      return response
    case 'drop-sampling':
      if (response.type !== 'sampling-dropped') break
      assertSamplingIdentity(response, request)
      return response
    case 'dispose':
      if (response.type === 'disposed') return response
      break
  }
  throw new TypeError(`Prediction Worker returned ${response.type} for a ${request.type} request.`)
}
