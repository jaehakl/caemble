import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { containedPath } from '@caemble/execution/node/artifact'
import { CliError } from '@caemble/execution/node/environment'
import type { CommandContext } from './types'

type ObjectReference = {
  kind: 'caemble.object'
  version: 1
  id: string
  encoding: 'json' | 'base64'
  byteLength: number
  sha256: string
}
type Dataset = Record<string, unknown> & {
  kind: 'caemble.prediction.dataset'
  version: 1
  datasetId: string
  revision: number
  fingerprint: string
  experimentId: number
  name?: string
}
type ArtifactFile = { name: string; byteLength: number; sha256: string }
type DatasetArtifact = {
  kind: 'caemble.prediction.dataset.artifact'
  version: 1
  identity: string
  revision: number
  metadata: { datasetId: string; revision: number; fingerprint: string; experimentId: number; name: string }
  files: ArtifactFile[]
}
type Grant = {
  dataset_id: string
  revision: number
  fingerprint: string
  grant_id: string
  manifest_url: string
  object_url_template: string
  manifest_sha256: string
  token: string
}
type ObjectTicket = {
  reference: ObjectReference
  parts: { url: string; headers?: Record<string, string>; byteLength: number; sha256: string }[]
}

function datasetReferences(value: unknown): { dataset: Dataset; references: Map<string, ObjectReference> } {
  const dataset = value as Dataset
  if (
    !dataset ||
    dataset.kind !== 'caemble.prediction.dataset' ||
    dataset.version !== 1 ||
    typeof dataset.datasetId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(dataset.datasetId) ||
    !Number.isSafeInteger(dataset.revision) ||
    dataset.revision < 1 ||
    typeof dataset.fingerprint !== 'string' ||
    !dataset.fingerprint ||
    !Number.isSafeInteger(dataset.experimentId) ||
    !dataset.varsSchema ||
    !Array.isArray(dataset.measurements)
  )
    throw new CliError('Expected a Caemble Prediction Dataset v1 manifest.', 4)
  const references = new Map<string, ObjectReference>()
  function visit(member: unknown) {
    if (!member || typeof member !== 'object') return
    if ('kind' in member && member.kind === 'caemble.object') {
      const reference = member as ObjectReference
      if (
        reference.version !== 1 ||
        !['json', 'base64'].includes(reference.encoding) ||
        typeof reference.id !== 'string' ||
        !reference.id ||
        !Number.isSafeInteger(reference.byteLength) ||
        reference.byteLength < 0 ||
        typeof reference.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(reference.sha256)
      )
        throw new CliError('Dataset contains an invalid stored object reference.', 4)
      const previous = references.get(reference.id)
      if (
        previous &&
        ['sha256', 'byteLength', 'encoding'].some(
          (key) => previous[key as keyof ObjectReference] !== reference[key as keyof ObjectReference],
        )
      )
        throw new CliError('Dataset contains conflicting stored object references.', 4)
      references.set(reference.id, reference)
      return
    }
    for (const child of Object.values(member)) visit(child)
  }
  visit(dataset)
  return { dataset, references }
}

async function verifyFile(directory: string, file: ArtifactFile, signal: AbortSignal) {
  if (
    !file ||
    typeof file.name !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(file.name) ||
    ['.', '..', 'manifest.json'].includes(file.name) ||
    !Number.isSafeInteger(file.byteLength) ||
    file.byteLength < 0 ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new CliError('Dataset artifact contains an invalid file entry.', 4)
  if ((await lstat(path.join(directory, file.name))).isSymbolicLink())
    throw new CliError('Dataset artifact files must not be symbolic links.', 4)
  const resolved = await containedPath(directory, file.name)
  const hash = createHash('sha256')
  let length = 0
  for await (const bytes of createReadStream(resolved)) {
    signal.throwIfAborted()
    length += bytes.length
    hash.update(bytes)
  }
  if (length !== file.byteLength || hash.digest('hex') !== file.sha256)
    throw new CliError(`Dataset file checksum or length changed: ${file.name}`, 4)
}

export async function validateDatasetArtifact(location: string, signal: AbortSignal) {
  const directory = path.resolve(location)
  const artifact = JSON.parse(
    await readFile(await containedPath(directory, 'manifest.json'), 'utf8'),
  ) as DatasetArtifact
  if (
    artifact.kind !== 'caemble.prediction.dataset.artifact' ||
    artifact.version !== 1 ||
    !Array.isArray(artifact.files)
  )
    throw new CliError('Expected a Caemble Prediction Dataset artifact v1.', 4)
  const names = new Set<string>()
  for (const file of artifact.files) {
    if (names.has(file.name)) throw new CliError('Dataset artifact lists a file more than once.', 4)
    names.add(file.name)
    await verifyFile(directory, file, signal)
  }
  if (!names.has('dataset.json')) throw new CliError('Dataset artifact is missing dataset.json.', 4)
  const { dataset, references } = datasetReferences(
    JSON.parse(await readFile(await containedPath(directory, 'dataset.json'), 'utf8')),
  )
  if (
    artifact.identity !== dataset.datasetId ||
    artifact.revision !== dataset.revision ||
    artifact.metadata?.datasetId !== dataset.datasetId ||
    artifact.metadata?.revision !== dataset.revision ||
    artifact.metadata?.fingerprint !== dataset.fingerprint ||
    artifact.metadata?.experimentId !== dataset.experimentId
  )
    throw new CliError('Dataset identity or revision differs between its manifests.', 4)
  const expected = new Set(['dataset.json'])
  for (const reference of references.values()) {
    const name = `${reference.sha256}.object`
    const entry = artifact.files.find((file) => file.name === name)
    if (!entry || entry.sha256 !== reference.sha256 || entry.byteLength !== reference.byteLength)
      throw new CliError(`Dataset artifact is missing its pinned object: ${reference.id}`, 4)
    expected.add(name)
  }
  if (names.size !== expected.size || [...names].some((name) => !expected.has(name)))
    throw new CliError('Dataset artifact contains files outside its pinned Dataset.', 4)
  return {
    path: directory,
    datasetId: dataset.datasetId,
    revision: dataset.revision,
    fingerprint: dataset.fingerprint,
    files: names.size,
    valid: true,
  }
}

export async function datasetCommand(command: string, context: CommandContext) {
  const { args, options, signal } = context
  if (command === 'validate') {
    if (!args[0]) throw new CliError('dataset validate requires a bundle directory.')
    return validateDatasetArtifact(args[0], signal)
  }
  if (command !== 'export' || !args[0] || !options.out)
    throw new CliError(
      'Use dataset export <id> [--revision N] --out <empty-directory> or dataset validate <directory>.',
    )
  const client = context.client()
  const identity = args[0]
  let revision = Number(options.revision)
  if (options.revision === undefined) {
    const response = await client.request<{ items: { id: string; current_revision: number }[] }>(
      'get',
      '/prediction/datasets',
      undefined,
      { signal },
    )
    const selected = response.items.find((item) => item.id === identity)
    if (!selected) throw new CliError('Dataset not found.')
    revision = selected.current_revision
  }
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new CliError('Dataset revision must be a positive integer.')
  const directory = path.resolve(String(options.out))
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) throw new CliError('Dataset export directory must be empty.')
  const grant = await client.request<Grant>(
    'post',
    `/prediction/datasets/${encodeURIComponent(identity)}/grants`,
    { revision },
    { signal },
  )
  let grantReleased = false
  try {
    const origin = new URL(context.environment.apiUrl!)
    async function grantedFetch(url: string) {
      signal.throwIfAborted()
      const address = new URL(url)
      const prefix = `${origin.pathname.replace(/\/$/, '')}/prediction/datasets/${encodeURIComponent(identity)}/revisions/${revision}/`
      if (
        address.origin !== origin.origin ||
        address.username ||
        address.password ||
        address.hash ||
        !address.pathname.startsWith(prefix)
      )
        throw new CliError('Dataset grant does not belong to the configured API.', 4)
      const response = await fetch(address, {
        headers: { Authorization: `Bearer ${grant.token}` },
        redirect: 'error',
        signal,
      })
      if (!response.ok) throw new CliError(`Dataset grant read failed (${response.status}).`)
      return response
    }
    const raw = Buffer.from(await (await grantedFetch(grant.manifest_url)).arrayBuffer())
    const manifestHash = createHash('sha256').update(raw).digest('hex')
    if (manifestHash !== grant.manifest_sha256)
      throw new CliError('Dataset manifest checksum differs from its grant.', 4)
    const { dataset, references } = datasetReferences(JSON.parse(raw.toString('utf8')))
    if (
      grant.dataset_id !== identity ||
      grant.revision !== revision ||
      dataset.datasetId !== identity ||
      dataset.revision !== revision ||
      dataset.fingerprint !== grant.fingerprint
    )
      throw new CliError('Dataset identity differs from the requested revision.', 4)
    const files: ArtifactFile[] = [{ name: 'dataset.json', byteLength: raw.length, sha256: manifestHash }]
    await writeFile(path.join(directory, 'dataset.json'), raw, { flag: 'wx' })
    for (const reference of references.values()) {
      signal.throwIfAborted()
      const name = `${reference.sha256}.object`
      if (files.some((file) => file.name === name)) continue
      const ticketUrl = grant.object_url_template.replace('{object_id}', encodeURIComponent(reference.id))
      const ticket = (await (await grantedFetch(ticketUrl)).json()) as ObjectTicket
      if (
        !ticket.reference ||
        ['id', 'sha256', 'byteLength', 'encoding'].some(
          (key) => ticket.reference[key as keyof ObjectReference] !== reference[key as keyof ObjectReference],
        )
      )
        throw new CliError('Stored object ticket differs from its Dataset reference.', 4)
      const target = await open(path.join(directory, name), 'wx')
      const hash = createHash('sha256')
      let length = 0
      try {
        for (const part of ticket.parts) {
          const address = new URL(part.url)
          const headers = new Headers(part.headers)
          if (
            !['http:', 'https:'].includes(address.protocol) ||
            address.username ||
            address.password ||
            headers.has('authorization') ||
            headers.has('cookie') ||
            !Number.isSafeInteger(part.byteLength) ||
            part.byteLength < 0 ||
            !/^[a-f0-9]{64}$/.test(part.sha256)
          )
            throw new CliError('Stored object download ticket is invalid.', 4)
          const response = await fetch(address, { headers, credentials: 'omit', redirect: 'error', signal })
          if (!response.ok || !response.body) throw new CliError(`Stored object download failed (${response.status}).`)
          const chunkHash = createHash('sha256')
          let chunkLength = 0
          const reader = response.body.getReader()
          try {
            while (true) {
              signal.throwIfAborted()
              const next = await reader.read()
              if (next.done) break
              chunkLength += next.value.byteLength
              length += next.value.byteLength
              if (chunkLength > part.byteLength || length > reference.byteLength)
                throw new CliError('Stored object exceeds its declared size.', 4)
              chunkHash.update(next.value)
              hash.update(next.value)
              await target.writeFile(next.value)
            }
          } finally {
            await reader.cancel()
            reader.releaseLock()
          }
          if (chunkLength !== part.byteLength || chunkHash.digest('hex') !== part.sha256)
            throw new CliError('Stored object chunk checksum differs from its manifest.', 4)
        }
      } finally {
        await target.close()
      }
      if (length !== reference.byteLength || hash.digest('hex') !== reference.sha256)
        throw new CliError('Stored object checksum differs from its Dataset reference.', 4)
      files.push({ name, byteLength: length, sha256: reference.sha256 })
    }
    const artifact: DatasetArtifact = {
      kind: 'caemble.prediction.dataset.artifact',
      version: 1,
      identity,
      revision,
      metadata: {
        datasetId: identity,
        revision,
        fingerprint: dataset.fingerprint,
        experimentId: dataset.experimentId,
        name: dataset.name ?? identity,
      },
      files,
    }
    signal.throwIfAborted()
    // Only a fully downloaded bundle has the publication manifest.
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(artifact, null, 2), {
      encoding: 'utf8',
      flag: 'wx',
    })
    await validateDatasetArtifact(directory, signal)
  } finally {
    try {
      await client.request(
        'post',
        `/prediction/datasets/${encodeURIComponent(identity)}/grants/${encodeURIComponent(grant.grant_id)}/release`,
      )
      grantReleased = true
    } catch {
      process.stderr.write('Dataset read grant release failed; the server lease will expire automatically.\n')
    }
  }
  return { path: directory, datasetId: identity, revision, grantReleased }
}
