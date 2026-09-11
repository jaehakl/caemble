import type { RecordedResultContracts } from '@/contracts/results'
import { constants } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BuiltArtifactInput } from '@/lib/cae/artifact'
import { createDataTensorAccessor, isDataTensor } from '@/lib/cad/model/dataTensor'
import type { RecordedData, RecordedDataNode, RecordedDataRule, RecordedDataTensor } from '@/lib/cad/model/descriptor'
import { flattenRecordedData, recordedDataRules } from '@/lib/cad/simulation/recordedData'
import type { RecordedDataSchemaTree, ResolvedDataSchemaNode } from '@/lib/cad/simulation/types'
import { createCalculationInput } from '@/lib/calculation/input'
import { CALCULATION_INPUT_MAX_BYTES, CalculationExecutionError } from '@/lib/calculation/types'
import { containedPath, openArtifact } from './artifact'
import { CliError } from './environment'

type LocalAttachment = Readonly<{ id: string; path: string; byteLength: number; mimeType: string }>
type LocalRecord = Readonly<{
  sequence: number
  name: string
  path: string
  schema: ResolvedDataSchemaNode
  attachments: readonly LocalAttachment[]
}>
export type LocalResultManifest = Readonly<{
  kind: 'local-cae-result'
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  input: string
  inputHash: string
  sourceHash: string
  catalogRevision: string
  jobId: string
  records: readonly LocalRecord[]
  recordSequences: readonly number[]
  recordedBytes: number
  trace: readonly unknown[]
  durationMs?: number
  error?: Readonly<{ code: string; message: string }>
}>

async function loadLocalResult(location: string): Promise<{
  directory: string
  manifest: LocalResultManifest
  schemas: RecordedDataSchemaTree
  resultContracts: RecordedResultContracts
  rules: readonly RecordedDataRule[]
  flat: RecordedData
  attachments: Map<string, LocalAttachment>
}> {
  const directory = path.resolve(location.endsWith('.json') ? path.dirname(location) : location)
  const rawManifest = JSON.parse(await readFile(await containedPath(directory, 'manifest.json'), 'utf8'))
  if (rawManifest.kind === 'caemble.local-executions') {
    const choices = (rawManifest.executions as unknown[]).map((_, index) => path.join(directory, String(index + 1)))
    if (choices.length !== 1)
      throw new CliError(`Select one local execution directory: ${choices.join(', ') || 'no completed executions'}.`)
    return loadLocalResult(await containedPath(directory, '1'))
  }
  if (rawManifest.kind !== 'local-cae-result') throw new CliError('Select a local CAE result directory.')
  const manifest = { ...rawManifest, input: path.resolve(directory, rawManifest.input) } as LocalResultManifest
  const original = await openArtifact(path.dirname(path.dirname(manifest.input)))
  const relativeInput = path.relative(original.directory, manifest.input).replace(/\\/g, '/')
  const entry = original.artifact.items.find((item) => item.file === relativeInput)
  if (
    !entry ||
    entry.input_hash !== manifest.inputHash ||
    original.artifact.source_hash !== manifest.sourceHash ||
    original.artifact.catalog_revision !== manifest.catalogRevision
  ) {
    throw new CliError('Local result provenance does not match its original build artifact.', 4)
  }
  const input = JSON.parse((await original.readItem(entry)).toString('utf8')) as BuiltArtifactInput
  const schemas = input.measurement.experiment.simulationProgram.recordedData
  const records: Record<string, RecordedDataNode> = {}
  const attachments = new Map<string, LocalAttachment>()
  for (const record of manifest.records) {
    if (JSON.stringify(schemas[record.name]) !== JSON.stringify(record.schema))
      throw new CliError(`RecordedData ${record.name} schema differs from its build input.`, 4)
    const stored = JSON.parse(await readFile(await containedPath(directory, record.path), 'utf8')) as LocalRecord & {
      value: RecordedDataNode
    }
    if (
      stored.sequence !== record.sequence ||
      stored.name !== record.name ||
      JSON.stringify(stored.schema) !== JSON.stringify(record.schema) ||
      JSON.stringify(stored.attachments) !== JSON.stringify(record.attachments)
    ) {
      throw new CliError(`RecordedData ${record.name} metadata differs from its result manifest.`, 4)
    }
    records[record.name] = stored.value
    for (const attachment of record.attachments) {
      if (attachments.has(attachment.id)) throw new CliError(`Duplicate local attachment: ${attachment.id}`, 4)
      attachments.set(attachment.id, attachment)
    }
  }
  return {
    directory,
    manifest,
    schemas,
    resultContracts: input.measurement.experiment.simulationProgram.resultContracts,
    rules: recordedDataRules(schemas, 'local.recorded-data'),
    flat: flattenRecordedData(schemas, records)!,
    attachments,
  }
}

async function readTensorBytes(
  result: Awaited<ReturnType<typeof loadLocalResult>>,
  tensor: RecordedDataTensor,
  firstByte = 0,
  byteLength?: number,
) {
  if (tensor.storage.kind !== 'attachments') throw new CliError('Expected an attachment tensor.')
  const length = byteLength ?? tensor.storage.byteLength
  const bytes = Buffer.alloc(length)
  let shardOffset = 0
  let copied = 0
  for (const id of tensor.storage.ids) {
    const attachment = result.attachments.get(id)
    if (!attachment) throw new CliError(`Local result attachment is missing: ${id}`, 4)
    const first = Math.max(firstByte, shardOffset)
    const last = Math.min(firstByte + length, shardOffset + attachment.byteLength)
    const file = await open(await containedPath(result.directory, attachment.path), 'r')
    try {
      if ((await file.stat()).size !== attachment.byteLength)
        throw new CliError(`Local result attachment size changed: ${id}`, 4)
      let position = first
      while (position < last) {
        const read = await file.read(bytes, position - firstByte, last - position, position - shardOffset)
        if (read.bytesRead === 0) throw new CliError(`Local result attachment was truncated: ${id}`, 4)
        position += read.bytesRead
        copied += read.bytesRead
      }
    } finally {
      await file.close()
    }
    shardOffset += attachment.byteLength
  }
  if (shardOffset !== tensor.storage.byteLength || copied !== length)
    throw new CliError('Local tensor attachment lengths do not match its storage metadata.', 4)
  return bytes
}

/** Converts persisted CAE tensors with the same decoder and input contract as the web UI. */
export async function createLocalCalculationInput(location: string, names?: readonly string[]) {
  const result = await loadLocalResult(location)
  if (result.manifest.state !== 'succeeded')
    throw new CliError(`Calculation requires a successful local result; found ${result.manifest.state}.`, 4)
  const rules =
    names === undefined
      ? result.rules
      : names.map((name) => {
          const rule = result.rules.find((item) => item.label === name)
          if (!rule) throw new CliError(`RecordedData ${name} is not declared.`, 4)
          return rule
        })
  const totalBytes = rules.reduce((total, rule) => {
    const tensor = result.flat[rule.label]
    if (!isDataTensor(tensor)) throw new CliError(`RecordedData ${rule.label} is missing.`, 4)
    return total + (tensor.storage.kind === 'inline' ? 0 : tensor.storage.byteLength)
  }, 0)
  if (totalBytes > CALCULATION_INPUT_MAX_BYTES)
    throw new CalculationExecutionError(
      'input-too-large',
      `Calculation input exceeds ${CALCULATION_INPUT_MAX_BYTES} bytes.`,
    )
  const hydrated: Record<string, RecordedDataTensor> = {}
  for (const rule of rules) {
    const tensor = result.flat[rule.label] as RecordedDataTensor
    hydrated[rule.label] =
      tensor.storage.kind !== 'attachments'
        ? tensor
        : {
            ...tensor,
            storage: {
              kind: 'base64',
              data: (await readTensorBytes(result, tensor)).toString('base64'),
              byteLength: tensor.storage.byteLength,
            },
          }
  }
  return createCalculationInput(rules, hydrated)
}

/** Reads record metadata without materializing binary payloads. */
export async function inspectLocalResult(location: string) {
  const result = await loadLocalResult(location)
  return {
    manifest: result.manifest,
    resultContracts: result.resultContracts,
    records: result.rules.map((rule) => {
      const tensor = result.flat[rule.label]
      return {
        name: rule.label,
        schema: rule.result,
        present: isDataTensor(tensor),
        shape: isDataTensor(tensor) ? tensor.shape : null,
        axes: isDataTensor(tensor) ? (tensor.axes ?? []) : [],
        storage: isDataTensor(tensor) ? tensor.storage.kind : null,
        byteLength: isDataTensor(tensor) && tensor.storage.kind !== 'inline' ? tensor.storage.byteLength : null,
      }
    }),
  }
}

/** Copies one execution and its frozen input without converting binary records to JSON. */
export async function exportLocalResult(location: string, output: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const result = await loadLocalResult(location)
  const directory = path.resolve(output)
  await mkdir(directory, { recursive: true })
  if ((await readdir(directory)).length) throw new CliError('Local export directory must be empty.')
  const original = await openArtifact(path.dirname(path.dirname(result.manifest.input)))
  const relativeInput = path.relative(original.directory, result.manifest.input).replace(/\\/g, '/')
  const item = original.artifact.items.find((entry) => entry.file === relativeInput)
  if (!item || item.input_hash !== result.manifest.inputHash)
    throw new CliError('Local result provenance changed during export.', 4)
  const bytes = await original.readItem(item)
  const input = 'artifact/items/1.json'
  await mkdir(path.join(directory, 'artifact/items'), { recursive: true })
  await writeFile(path.join(directory, input), bytes, { flag: 'wx' })
  await writeFile(
    path.join(directory, 'artifact/manifest.json'),
    JSON.stringify({ ...original.artifact, items: [{ ...item, index: 1, file: 'items/1.json' }] }, null, 2),
    { encoding: 'utf8', flag: 'wx' },
  )
  for (const tensor of Object.values(result.flat)) {
    if (!isDataTensor(tensor) || tensor.storage.kind !== 'attachments') continue
    const storedBytes = tensor.storage.ids.reduce((total, id) => {
      const attachment = result.attachments.get(id)
      if (!attachment) throw new CliError(`Local result attachment is missing: ${id}`, 4)
      return total + attachment.byteLength
    }, 0)
    if (storedBytes !== tensor.storage.byteLength)
      throw new CliError('Local tensor attachment lengths do not match its storage metadata.', 4)
  }
  const files = [
    ...result.manifest.records.map((record) => ({ path: record.path, byteLength: undefined })),
    ...result.attachments.values(),
  ]
  for (const file of files) {
    signal?.throwIfAborted()
    const source = await containedPath(result.directory, file.path)
    const target = path.resolve(directory, file.path)
    const relative = path.relative(directory, target)
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new CliError(`Local export path escapes the output directory: ${file.path}`, 4)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target, constants.COPYFILE_EXCL)
    if (file.byteLength !== undefined && (await stat(target)).size !== file.byteLength)
      throw new CliError(`Local result attachment size changed: ${file.path}`, 4)
  }
  signal?.throwIfAborted()
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ ...result.manifest, input }, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  })
  await loadLocalResult(directory)
  return { path: directory, kind: 'local-cae-result', inputHash: result.manifest.inputHash }
}

/** Numeric attachment slices read only the requested byte range, including shard boundaries. */
export async function sliceLocalResult(
  location: string,
  name: string,
  request: Readonly<{ offset?: number; limit?: number }> = {},
) {
  const result = await loadLocalResult(location)
  const rule = result.rules.find((item) => item.label === name)
  const tensor = result.flat[name]
  if (!rule || !isDataTensor(tensor)) throw new CliError(`RecordedData ${name} is missing.`, 4)
  const total = tensor.shape.reduce((size, length) => size * length, 1)
  const offset = request.offset ?? 0
  const limit = request.limit ?? 100
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > total ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 10_000
  ) {
    throw new CliError('Slice offset must address the tensor and limit must be an integer between 0 and 10000.')
  }
  const count = Math.min(limit, total - offset)
  let selected: RecordedDataTensor = tensor
  let firstIndex = offset
  if (tensor.storage.kind === 'attachments') {
    const numeric = rule.result.dtype !== 'string'
    const width = total === 0 ? 0 : tensor.storage.byteLength / total
    if (numeric && (!Number.isSafeInteger(width) || width < 0))
      throw new CliError('Local tensor byte length is inconsistent with its shape.', 4)
    const raw = numeric
      ? await readTensorBytes(result, tensor, offset * width, count * width)
      : await readTensorBytes(result, tensor)
    selected = {
      ...tensor,
      ...(numeric ? { shape: [count], axes: [] } : {}),
      storage: { kind: 'base64', data: raw.toString('base64'), byteLength: raw.byteLength },
    }
    if (numeric) firstIndex = 0
  }
  const accessor = createDataTensorAccessor(rule.result, selected, name)
  return {
    name,
    schema: rule.result,
    shape: tensor.shape,
    axes: tensor.axes ?? [],
    offset,
    total,
    values: Array.from({ length: count }, (_, index) => accessor.at(firstIndex + index)),
  }
}
