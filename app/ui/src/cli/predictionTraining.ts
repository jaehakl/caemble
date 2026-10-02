import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { createPredictionApi } from '@/api/prediction'
import {
  defaultPredictionQualityValidation,
  predictionLocationIdSchema,
  type PredictionOperation,
} from '@/contracts/api/prediction'
import {
  buildPredictionModelDefinition,
  predictionAlgorithmSchema,
} from '@caemble/execution/prediction/modelDefinition'
import { CliError } from '@caemble/execution/node/environment'
import type { CommandContext } from './types'

const trainingConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    dataset_id: z.string().uuid(),
    dataset_revision: z.number().int().positive(),
    storage_id: predictionLocationIdSchema,
    launcher_id: z.string().uuid(),
    record_ids: z.array(z.number().int().positive()).min(1),
    algorithm: predictionAlgorithmSchema,
    quality_validation: z.boolean().default(false),
  })
  .strict()

/** Operations contain scoped grants; CLI output deliberately projects observable state. */
function trainingStatus(operation: PredictionOperation) {
  if (operation.kind !== 'prepare' || operation.asset_kind !== 'model')
    throw new CliError('This operation is not a model training request.', 4)
  return {
    operation_id: operation.id,
    request_id: operation.request_id,
    model_id: operation.asset_id,
    revision: operation.revision,
    state: operation.state,
    stage: operation.stage,
    error: operation.error,
    job_id: operation.training?.jobId ?? null,
    cleanup_pending: operation.training?.cleanupPending ?? false,
    resources: operation.training?.resources,
    progress: operation.training?.progress,
  }
}

export async function predictionTrainingCommand(command: string, context: CommandContext) {
  const { args, options, signal } = context
  if (!['train', 'status', 'watch', 'cancel'].includes(command))
    throw new CliError(`Unknown prediction command: ${command}`)
  const api = createPredictionApi(context.client())
  if (command === 'train') {
    if (typeof options.config !== 'string') throw new CliError('prediction train requires --config <training.json>.')
    const config = trainingConfigSchema.parse(JSON.parse(await readFile(options.config, 'utf8')))
    const requestId = z
      .string()
      .uuid()
      .parse(options['request-id'] ?? randomUUID())
    const [datasets, descriptors] = await Promise.all([
      api.datasets(undefined, { signal }),
      api.algorithms({ signal }, config.launcher_id),
    ])
    const dataset = datasets.find((item) => item.id === config.dataset_id)
    const source = dataset?.revisions.find((item) => item.revision === config.dataset_revision)
    if (
      !dataset ||
      dataset.state !== 'active' ||
      dataset.source_kind !== 'server' ||
      !source ||
      !(source.api_payload_available ?? source.payload_available)
    )
      throw new CliError('CLI training requires an existing server Dataset revision with retained API payload.', 4)
    const descriptor = descriptors.find((item) => item.kind === config.algorithm.kind)
    if (!descriptor) throw new CliError('The selected algorithm is not supported by this Predictor.', 4)
    const definition = await buildPredictionModelDefinition({
      snapshotFingerprint: source.fingerprint,
      algorithm: config.algorithm,
      descriptor,
      sourceContracts: source.source_contracts,
      recordIds: config.record_ids,
      ...(config.quality_validation ? { qualityValidation: defaultPredictionQualityValidation } : {}),
    })
    // Print the recovery ID before a request can reach the server, even if its response is lost.
    process.stderr.write(`Prediction training request: ${requestId}\n`)
    const reserved = await api.reserve(
      {
        request_id: requestId,
        name: config.name,
        direction: 'forward',
        dataset_id: config.dataset_id,
        dataset_revision: config.dataset_revision,
        dataset_source: 'api',
        storage_id: config.storage_id,
        launcher_id: config.launcher_id,
        definition,
      },
      { signal },
    )
    if (!reserved.operation_id || !reserved.reserved_revision)
      throw new CliError(`Training reservation was not acknowledged. Retry with --request-id ${requestId}.`, 4)
    const operation = await api.operation(reserved.operation_id, { signal })
    if (operation.training?.jobId || operation.state !== 'pending') return trainingStatus(operation)
    return trainingStatus(await api.submitTraining(operation.id, {}, { signal }))
  }
  const id = z.string().uuid().parse(args[0])
  if (command === 'status') return trainingStatus(await api.operation(id, { signal }))
  if (command === 'cancel') {
    trainingStatus(await api.operation(id, { signal }))
    return trainingStatus(await api.cancelOperation(id))
  }
  const timeout = options.timeout === undefined ? undefined : Number(options.timeout) * 1000
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    throw new CliError('--timeout must be a positive number of seconds.')
  const observed = new AbortController()
  const abort = () =>
    observed.abort(new CliError('Observation interrupted. Training continues; use prediction cancel to stop it.', 130))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(
          () => observed.abort(new CliError('Training observation timed out. Training continues.', 5)),
          timeout,
        )
  try {
    while (true) {
      const status = trainingStatus(await api.operation(id, { signal: observed.signal }))
      process.stdout.write(`${JSON.stringify({ type: 'snapshot', training: status })}\n`)
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status.state) && !status.cleanup_pending) {
        if (status.state !== 'completed')
          throw new CliError(`Training is ${status.state}: ${status.error ?? status.stage}.`, 1)
        return undefined
      }
      await delay(2000, undefined, { signal: observed.signal })
    }
  } catch (error) {
    if (observed.signal.aborted) throw observed.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
