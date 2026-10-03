import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createOptimizationApi } from '@/api/optimization'
import type { Optimization, OptimizationCreateRequest } from '@/contracts/api/optimization'
import { openArtifact } from '@caemble/execution/node/artifact'
import { CliError } from '@caemble/execution/node/environment'
import type { BuiltArtifactInput } from '@caemble/execution/cae/artifact'
import type { CommandContext } from './types'

type Receipt = { api: string; requestId: string; body: unknown; acknowledged: boolean; optimizationId?: string }

async function readReceipt(file: string, retry: boolean): Promise<Receipt | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let saved: Receipt & { studyId?: string }
  try {
    saved = JSON.parse(text)
    if (
      !saved ||
      typeof saved.api !== 'string' ||
      typeof saved.requestId !== 'string' ||
      !saved.requestId ||
      typeof saved.acknowledged !== 'boolean' ||
      !Object.prototype.hasOwnProperty.call(saved, 'body') ||
      (saved.optimizationId !== undefined && typeof saved.optimizationId !== 'string') ||
      (saved.studyId !== undefined && typeof saved.studyId !== 'string') ||
      (saved.optimizationId !== undefined && saved.studyId !== undefined && saved.optimizationId !== saved.studyId)
    )
      throw new Error('Invalid receipt.')
    if (
      retry &&
      saved.body &&
      typeof saved.body === 'object' &&
      Object.prototype.hasOwnProperty.call(saved.body, 'study')
    ) {
      const { study, ...body } = saved.body as Record<string, unknown>
      if (Object.prototype.hasOwnProperty.call(body, 'optimization') && body.optimization !== study)
        throw new Error('Conflicting IDs.')
      saved.body = { ...body, optimization: study }
    }
  } catch {
    throw new CliError(
      `Saved request is invalid: ${file}. Preserve the receipt and recover its request ID before retrying.`,
      4,
    )
  }
  return {
    api: saved.api,
    requestId: saved.requestId,
    body: saved.body,
    acknowledged: saved.acknowledged,
    ...((saved.optimizationId ?? saved.studyId) === undefined
      ? {}
      : { optimizationId: saved.optimizationId ?? saved.studyId }),
  }
}

async function writeReceipt(file: string, receipt: Receipt) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(receipt, null, 2), 'utf8')
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function submitRequest(
  file: string,
  api: string,
  body: unknown,
  explicitId: string | undefined,
  repeatAcknowledged: boolean,
  submit: (id: string) => Promise<Optimization>,
  legacyFile?: string,
) {
  let saved = await readReceipt(file, legacyFile !== undefined)
  if (legacyFile) {
    const legacy = await readReceipt(legacyFile, true)
    if (legacy) {
      // A previous attempt may have committed the new file before removing the old one.
      // Never choose between different requests: either could already have reached the API.
      if (saved && !isDeepStrictEqual(saved, legacy))
        throw new CliError(
          `Saved requests conflict: ${file} and ${legacyFile}. Reconcile both receipts before retrying.`,
          4,
        )
      saved ??= legacy
      await writeReceipt(file, saved)
      await rm(legacyFile)
    }
  }
  const reuse =
    saved && (explicitId === saved.requestId || (!explicitId && (repeatAcknowledged || !saved.acknowledged)))
      ? saved
      : undefined
  if (reuse && (reuse.api !== api || !isDeepStrictEqual(reuse.body, body)))
    throw new CliError('This request has different settings. Use a new --request-id to create another request.', 4)
  const receipt: Receipt = {
    api,
    body,
    requestId: explicitId ?? reuse?.requestId ?? randomUUID(),
    acknowledged: false,
    ...(reuse?.optimizationId === undefined ? {} : { optimizationId: reuse.optimizationId }),
  }
  await writeReceipt(file, receipt)
  const result = await submit(receipt.requestId)
  await writeReceipt(file, { ...receipt, acknowledged: true, optimizationId: result.id })
  return result
}

export async function optimizationCommand(command: string, context: CommandContext) {
  const { args, options, signal, environment } = context
  const client = context.client()
  const optimizations = createOptimizationApi(client)
  if (command === 'create') {
    if (!args[0] || !options.experiment || !options.config)
      throw new CliError('optimization create <artifact> requires --experiment <id> and --config <optimization.json>.')
    const stored = await openArtifact(args[0])
    if (!options.item && stored.artifact.items.length !== 1)
      throw new CliError('Select one artifact item with --item <index>.')
    const item = stored.artifact.items.find((entry) => entry.index === Number(options.item ?? 1))
    if (!item) throw new CliError('The selected artifact item does not exist.')
    const { measurement } = JSON.parse((await stored.readItem(item)).toString('utf8')) as BuiltArtifactInput
    const configPath = path.resolve(String(options.config))
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Pick<
      OptimizationCreateRequest,
      'name' | 'objective' | 'constraints' | 'axes' | 'max_trials' | 'max_parallel' | 'hybrid' | 'algorithm'
    >
    const body = {
      ...config,
      experiment_id: Number(options.experiment),
      source_hash: stored.artifact.source_hash,
      vars_schema: measurement.experiment.varsSchema,
      initial_vars: measurement.experiment.variables,
    }
    return submitRequest(
      `${configPath}.submission.json`,
      client.baseUrl,
      body,
      options['request-id'] as string | undefined,
      true,
      (request_id) => optimizations.create({ ...body, request_id }, { signal }),
    )
  }
  if (command === 'list')
    return optimizations.list(
      {
        experimentId: options.experiment ? Number(options.experiment) : undefined,
        limit: Number(options.limit ?? 50),
        offset: Number(options.offset ?? 0),
      },
      { signal },
    )
  const id = args[0]
  if (!id) throw new CliError(`optimization ${command} requires an Optimization ID.`)
  if (command === 'show') return optimizations.read(id, { signal })
  if (command === 'trials')
    return optimizations.trials(id, Number(options.offset ?? 0), { signal }, Number(options.limit ?? 50))
  if (command === 'stop') return optimizations.stop(id, { signal })
  if (command === 'resume') return optimizations.resume(id, { signal })
  if (command === 'delete') return optimizations.remove(id, { signal })
  if (command === 'model-update') {
    const updateMode = options['update-mode'] ?? 'rebuild'
    if (updateMode !== 'rebuild' && updateMode !== 'warm_start' && updateMode !== 'incremental')
      throw new CliError('--update-mode must be rebuild, warm_start, or incremental.')
    const body = { optimization: id, update_mode: updateMode }
    const key = createHash('sha256')
      .update(JSON.stringify([client.baseUrl, id, 'model-update']))
      .digest('hex')
    return submitRequest(
      path.join(environment.repo, '.data/cli/optimization-requests', `${key}.json`),
      client.baseUrl,
      body,
      options['request-id'] as string | undefined,
      false,
      (requestId) => optimizations.modelUpdate(id, requestId, body.update_mode, { signal }),
    )
  }
  if (command === 'retry') {
    if (options.evaluation) {
      if (options.trial) throw new CliError('Choose either --evaluation <evaluation-id> or --trial <trial-id>.')
      const evaluation = String(options.evaluation)
      const body = { optimization: id, evaluation }
      const key = createHash('sha256')
        .update(JSON.stringify([client.baseUrl, id, 'evaluation', evaluation]))
        .digest('hex')
      return submitRequest(
        path.join(environment.repo, '.data/cli/optimization-requests', `${key}.json`),
        client.baseUrl,
        body,
        options['request-id'] as string | undefined,
        false,
        (requestId) => optimizations.retryEvaluation(id, evaluation, requestId, { signal }),
      )
    }
    if (!options.trial)
      throw new CliError('optimization retry requires --evaluation <evaluation-id> or --trial <trial-id>.')
    const trial = String(options.trial)
    const body = { optimization: id, trial }
    const key = createHash('sha256')
      .update(JSON.stringify([client.baseUrl, id, trial]))
      .digest('hex')
    return submitRequest(
      path.join(environment.repo, '.data/cli/optimization-requests', `${key}.json`),
      client.baseUrl,
      body,
      options['request-id'] as string | undefined,
      false,
      (requestId) => optimizations.retry(id, trial, requestId, { signal }),
      path.join(environment.repo, '.data/cli/study-requests', `${key}.json`),
    )
  }
  if (command !== 'watch') throw new CliError(`Unknown optimization command: ${command}`)
  const timeout = options.timeout === undefined ? undefined : Number(options.timeout) * 1000
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    throw new CliError('--timeout must be a positive number of seconds.')
  const observed = new AbortController()
  const abort = () =>
    observed.abort(
      new CliError('Observation interrupted. The Optimization continues; use optimization stop to stop it.', 130),
    )
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(
          () => observed.abort(new CliError('Optimization observation timed out. The Optimization continues.', 5)),
          timeout,
        )
  try {
    while (true) {
      const optimization = await optimizations.read(id, { signal: observed.signal })
      process.stdout.write(`${JSON.stringify({ type: 'snapshot', optimization })}\n`)
      if (
        optimization.state !== 'running' &&
        !optimization.manual_retry_pending &&
        (!optimization.active || !optimization.continuation.supported) &&
        !optimization.executions_active &&
        !optimization.cleanup_pending
      ) {
        if (optimization.state !== 'completed')
          throw new CliError(
            `Optimization is ${optimization.state}: ${optimization.continuation.reason ?? optimization.pause_reason ?? 'not running'}.`,
            1,
          )
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
