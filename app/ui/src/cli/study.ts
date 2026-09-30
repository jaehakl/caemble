import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { createOptimizationApi } from '@/api/optimization'
import type { OptimizationStudy, StudyCreateRequest } from '@/contracts/api/optimization'
import { openArtifact } from '@/platform/node/artifact'
import { CliError } from '@/platform/node/environment'
import type { BuiltArtifactInput } from '@/lib/cae/artifact'
import type { CommandContext } from './types'

type Receipt = { api: string; requestId: string; body: unknown; acknowledged: boolean; studyId?: string }

async function submitRequest(
  file: string,
  api: string,
  body: unknown,
  explicitId: string | undefined,
  repeatAcknowledged: boolean,
  submit: (id: string) => Promise<OptimizationStudy>,
) {
  let saved: Receipt | undefined
  try {
    saved = JSON.parse(await readFile(file, 'utf8')) as Receipt
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
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
  }
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(receipt, null, 2), 'utf8')
  await rename(temporary, file)
  const result = await submit(receipt.requestId)
  await writeFile(temporary, JSON.stringify({ ...receipt, acknowledged: true, studyId: result.id }, null, 2), 'utf8')
  await rename(temporary, file)
  return result
}

export async function studyCommand(command: string, context: CommandContext) {
  const { args, options, signal, environment } = context
  const client = context.client()
  const studies = createOptimizationApi(client)
  if (command === 'create') {
    if (!args[0] || !options.experiment || !options.config)
      throw new CliError('study create <artifact> requires --experiment <id> and --config <study.json>.')
    const stored = await openArtifact(args[0])
    if (!options.item && stored.artifact.items.length !== 1)
      throw new CliError('Select one artifact item with --item <index>.')
    const item = stored.artifact.items.find((entry) => entry.index === Number(options.item ?? 1))
    if (!item) throw new CliError('The selected artifact item does not exist.')
    const { measurement } = JSON.parse((await stored.readItem(item)).toString('utf8')) as BuiltArtifactInput
    const configPath = path.resolve(String(options.config))
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Pick<
      StudyCreateRequest,
      'name' | 'objective' | 'constraints' | 'axes' | 'max_trials' | 'max_parallel'
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
      (request_id) => studies.create({ ...body, request_id }, { signal }),
    )
  }
  if (command === 'list')
    return studies.list(
      {
        experimentId: options.experiment ? Number(options.experiment) : undefined,
        limit: Number(options.limit ?? 50),
        offset: Number(options.offset ?? 0),
      },
      { signal },
    )
  const id = args[0]
  if (!id) throw new CliError(`study ${command} requires a Study ID.`)
  if (command === 'show') return studies.read(id, { signal })
  if (command === 'trials')
    return studies.trials(id, Number(options.offset ?? 0), { signal }, Number(options.limit ?? 50))
  if (command === 'stop') return studies.stop(id, { signal })
  if (command === 'resume') return studies.resume(id, { signal })
  if (command === 'delete') return studies.remove(id, { signal })
  if (command === 'retry') {
    if (!options.trial) throw new CliError('study retry requires --trial <trial-id>.')
    const trial = String(options.trial)
    const body = { study: id, trial }
    const key = createHash('sha256')
      .update(JSON.stringify([client.baseUrl, id, trial]))
      .digest('hex')
    return submitRequest(
      path.join(environment.repo, '.data/cli/study-requests', `${key}.json`),
      client.baseUrl,
      body,
      options['request-id'] as string | undefined,
      false,
      (requestId) => studies.retry(id, trial, requestId, { signal }),
    )
  }
  if (command !== 'watch') throw new CliError(`Unknown study command: ${command}`)
  const timeout = options.timeout === undefined ? undefined : Number(options.timeout) * 1000
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0))
    throw new CliError('--timeout must be a positive number of seconds.')
  const observed = new AbortController()
  const abort = () =>
    observed.abort(new CliError('Observation interrupted. The Study continues; use study stop to stop it.', 130))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer =
    timeout === undefined
      ? undefined
      : setTimeout(() => observed.abort(new CliError('Study observation timed out. The Study continues.', 5)), timeout)
  try {
    while (true) {
      const study = await studies.read(id, { signal: observed.signal })
      process.stdout.write(`${JSON.stringify({ type: 'snapshot', study })}\n`)
      if (
        study.state !== 'running' &&
        !study.manual_retry_pending &&
        !study.active &&
        !study.executions_active &&
        !study.cleanup_pending
      ) {
        if (study.state !== 'completed')
          throw new CliError(`Study is ${study.state}: ${study.pause_reason ?? 'not running'}.`, 1)
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
