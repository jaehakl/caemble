import { createCaeBatches } from '@/api/cae'
import { submitArtifact } from '@/api/submitArtifact'
import { openArtifact } from '@/platform/node/artifact'
import { CliError } from '@/platform/node/environment'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { CommandContext } from './types'

export async function batchCommand(command: string, context: CommandContext) {
  const { args, options, signal } = context
  const client = context.client()
  const batches = createCaeBatches(client)
  if (command === 'submit') {
    if (!args[0] || !options.experiment)
      throw new CliError('batch submit <artifact> requires --experiment <server-id>.')
    const stored = await openArtifact(args[0])
    const submissionPath = path.join(stored.directory, 'submission.json')
    const saved = existsSync(submissionPath) ? JSON.parse(await readFile(submissionPath, 'utf8')) : null
    const experimentId = Number(options.experiment)
    if (!options['request-id'] && saved && (saved.experimentId !== experimentId || saved.api !== client.baseUrl))
      throw new CliError(
        'This artifact is already associated with another submission target. Use an explicit --request-id for a new submission.',
        4,
      )
    const requestId = String(options['request-id'] ?? saved?.requestId ?? crypto.randomUUID())
    await writeFile(submissionPath, JSON.stringify({ api: client.baseUrl, experimentId, requestId }, null, 2), 'utf8')
    return submitArtifact({
      client,
      artifact: stored.artifact,
      experimentId,
      requestId,
      readItem: stored.readItem,
      signal,
      onRegistered: async (id) => {
        await writeFile(
          submissionPath,
          JSON.stringify({ api: client.baseUrl, experimentId, requestId, batchId: id }, null, 2),
          'utf8',
        )
      },
      onProgress: (completed, total) => process.stderr.write(`Uploaded ${completed}/${total}\n`),
    })
  }
  if (command === 'list')
    return batches.list(
      {
        experimentId: options.experiment ? Number(options.experiment) : undefined,
        limit: Number(options.limit ?? 50),
        offset: Number(options.offset ?? 0),
      },
      { signal },
    )
  if (!args[0]) throw new CliError(`batch ${command} requires a batch ID.`)
  if (command === 'show')
    return batches.read(
      args[0],
      { limit: Number(options.limit ?? 100), offset: Number(options.offset ?? 0) },
      { signal },
    )
  if (command === 'cancel') return batches.cancel(args[0])
  if (command === 'retry') return batches.retry(args[0], options.jobs ? String(options.jobs).split(',') : undefined)
  if (command !== 'watch') throw new CliError(`Unknown batch command: ${command}`)
  const observed = new AbortController()
  const abort = () =>
    observed.abort(
      new CliError('Observation interrupted. The server job continues; use batch cancel to cancel it.', 130),
    )
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const deadline = options.timeout
    ? setTimeout(
        () => observed.abort(new CliError('Batch observation timed out. The server job continues.', 5)),
        Number(options.timeout) * 1000,
      )
    : undefined
  try {
    const snapshot = await batches.read(args[0], {}, { signal: observed.signal })
    process.stdout.write(`${JSON.stringify({ type: 'snapshot', batch: snapshot })}\n`)
    if (snapshot.finished_at) {
      if (snapshot.failed || snapshot.cancelled)
        throw new CliError('Remote batch finished with failed or cancelled jobs.', 1)
      return undefined
    }
    let after = snapshot.last_event_id
    const end = options.timeout ? Date.now() + Number(options.timeout) * 1000 : Infinity
    while (!signal.aborted) {
      if (Date.now() >= end) throw new CliError('Batch observation timed out. The server job is still running.', 5)
      const response = await client.stream(`/cae/events?after=${after}`, observed.signal)
      if (!response.body) throw new CliError('The API did not return an event stream.', 1)
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let pending = ''
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          pending += value.replace(/\r\n/g, '\n')
          let boundary: number
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n')
            if (!data) continue
            const event = JSON.parse(data)
            after = Math.max(after, Number(event.id) || 0)
            if (event.batch_id !== args[0]) continue
            process.stdout.write(`${JSON.stringify(event)}\n`)
            const updated = await batches.read(args[0], {}, { signal: observed.signal })
            if (updated.finished_at) {
              process.stdout.write(`${JSON.stringify({ type: 'snapshot', batch: updated })}\n`)
              if (updated.failed || updated.cancelled)
                throw new CliError('Remote batch finished with failed or cancelled jobs.', 1)
              return undefined
            }
          }
          if (Date.now() >= end) throw new CliError('Batch observation timed out. The server job is still running.', 5)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new CliError('Observation interrupted. The server job continues; use batch cancel to cancel it.', 130)
  } catch (error) {
    if (observed.signal.aborted) throw observed.signal.reason
    throw error
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
  }
}
