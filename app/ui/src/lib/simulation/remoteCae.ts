import {
  GpStationClient,
  type CallResult,
  type JobEvent,
  type JobSession,
  type RequestAttachment,
} from '@gpstation/v1-master-js-sdk'
import type { BuiltSample, BuiltSetup } from '../cad'
import {
  createDataTensorAccessor,
  registerDataTensorAttachment,
  releaseDataTensorAttachments,
  type DataTensor,
  type RecordedData,
} from '../cad'
import type {
  SimulationProgramManifest,
  SimulationProgress,
  SimulationResult,
  SimulationTraceArtifact,
  SimulationTraceEntry,
} from './types'

const INPUT_LIMIT_BYTES = 256 * 1024 * 1024
const RECORDED_LIMIT_BYTES = 64 * 1024 * 1024
const SHARD_BYTES = 16 * 1024 * 1024
const INLINE_CALL_PAYLOAD_BYTES = 512 * 1024
const CONNECT_TIMEOUT_MS = 60_000
const FINISH_TIMEOUT_MS = 60_000
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1

type RemoteCaeCallbacks = Readonly<{
  onRecord?: (name: string, tensor: DataTensor) => void
  onStarted?: (runId: string) => void
  onStatus?: (status: 'validating' | 'running' | 'finalizing') => void
  onProgress?: (progress: SimulationProgress) => void
}>

type RemoteCaeOptions = Readonly<{
  apiBaseUrl: string
  token: string
  sample: BuiltSample
  setup: BuiltSetup
  callbacks?: RemoteCaeCallbacks
}>

type RemoteCaeRun = Readonly<{
  cancel: () => void
  promise: Promise<SimulationResult>
}>

type FailedPayload = Readonly<{
  kind: 'failed'
  sequence: number
  error: Readonly<{ code: string; message: string }>
}>

type StartPayload =
  | Readonly<{
      kind: 'started'
      runId: string
      programHash: string
      recordedDataSchemaHash: string
      maxRunSeconds: number
    }>
  | FailedPayload

type RecordPayload = Readonly<{
  kind: 'record'
  sequence: number
  name: string
  tensor: DataTensor
}>

type CompleteTracePayload = Readonly<{
  task: string
  kernel: Readonly<{ name: string; version: string; descriptorHash: string }>
  inputStateRevision: number
  outputStateRevision: number
  inputArtifacts: Readonly<
    Record<
      string,
      Readonly<{ id: string; artifactType: string }> | readonly Readonly<{ id: string; artifactType: string }>[]
    >
  >
  status: 'succeeded'
  startedAt: number
  finishedAt: number
  durationMs: number
  observations: Readonly<Record<string, unknown>>
}>

type CompletePayload = Readonly<{
  kind: 'complete'
  sequence: number
  recordSequences: readonly number[]
  trace: readonly CompleteTracePayload[]
  provenance: Readonly<{
    programHash: string
    recordedDataSchemaHash: string
    simulationApiVersion: string | number
    durationMs: number
  }>
  finalStateRevision: number
  finalState: unknown
}>

export class CaeSimulationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'CaeSimulationError'
  }
}

export function runRemoteCaeSimulation(options: RemoteCaeOptions): RemoteCaeRun {
  let cancelled = false
  let jobId: string | null = null
  let session: JobSession | null = null
  const attachmentIds: string[] = []

  const kill = async () => {
    if (!jobId) return
    try {
      const response = await fetch(
        `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/jobs/${encodeURIComponent(jobId)}/kill`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.token}` },
          keepalive: true,
          signal: AbortSignal.timeout(10_000),
        },
      )
      if (!response.ok) throw new Error(`GPStation kill failed with HTTP ${response.status}`)
    } catch {
      // Closing the peer still lets the launcher-side cancellation watchdog reset an unresponsive worker.
    }
  }

  const cancel = () => {
    if (cancelled) return
    cancelled = true
    void kill()
    session?.close()
    releaseDataTensorAttachments(attachmentIds)
  }

  const promise = (async () => {
    if (!options.token.trim()) throw new CaeSimulationError('access_token_required', 'GPStation Access Token이 필요합니다.')
    const manifest = options.setup.experiment.simulationProgram
    if (!manifest || manifest.formatVersion !== 2) {
      throw new CaeSimulationError('program_required', 'Python simulationProgram v2가 필요합니다.')
    }
    const request = serializeCaeRequest(options.sample, options.setup)
    const client = new GpStationClient({
      apiBaseUrl: options.apiBaseUrl,
      token: options.token,
    })
    let transportSucceeded = false
    try {
      const launchers = await client.listLaunchers()
      if (
        !launchers.some(
          (launcher) => launcher.status !== 'disconnected' && launcher.slave_app_ids.includes('cae'),
        )
      ) {
        throw new CaeSimulationError('cae_launcher_unavailable', '연결된 GPStation cae launcher가 없습니다.')
      }
      const started = await client.runJob<unknown, StartPayload>(
        'cae.simulation.start',
        request.payload,
        {
          slaveAppId: 'cae',
          autoFinish: false,
          timeoutMs: CONNECT_TIMEOUT_MS,
          attachments: request.attachments,
          onJobCreated(job) {
            jobId = job.id
            if (cancelled) void kill()
          },
        },
      )
      const jobSession = started.session
      session = jobSession
      if (cancelled) throw abortError()
      if (started.files.length > 0) {
        throw new CaeSimulationError('protocol_error', 'CAE start 응답은 attachment를 포함할 수 없습니다.')
      }
      const startedPayload: unknown = started.payload
      if (isRecord(startedPayload) && startedPayload.kind === 'failed') {
        assertFailedPayload(startedPayload)
        if (startedPayload.sequence !== 0) {
          throw new CaeSimulationError('protocol_error', 'CAE start failure sequence가 0이 아닙니다.')
        }
        await jobSession.finish({ timeoutMs: FINISH_TIMEOUT_MS })
        transportSucceeded = true
        throw new CaeSimulationError(startedPayload.error.code, startedPayload.error.message)
      }
      assertStarted(startedPayload, manifest.programHash, manifest.recordedDataSchemaHash)
      options.callbacks?.onStarted?.(startedPayload.runId)

      const records: Record<string, DataTensor> = {}
      const recordSequences: number[] = []
      let ackSequence: number | null = null
      let totalRecordedBytes = 0
      while (true) {
        if (cancelled) throw abortError()
        const response: CallResult<unknown> = await jobSession.call<
          Readonly<{ runId: string; ackSequence: number | null }>,
          unknown
        >(
          'cae.simulation.next',
          { runId: startedPayload.runId, ackSequence },
          {
            timeoutMs: (startedPayload.maxRunSeconds + 5 * 60) * 1000,
            onEvent: (event) => handleEvent(event, startedPayload.runId, options.callbacks),
          },
        )
        const payload = response.payload
        assertNextPayload(payload, manifest)
        if (payload.kind === 'record') {
          const record = payload
          if (record.sequence !== (ackSequence ?? 0) + 1) {
            throw new CaeSimulationError('protocol_error', 'CAE record sequence가 단조 증가하지 않습니다.')
          }
          const schema = manifest.recordedData[record.name]
          if (!schema || records[record.name]) {
            throw new CaeSimulationError('protocol_error', `선언되지 않았거나 중복된 record입니다: ${record.name}`)
          }
          const tensor = await cacheRecordAttachments(
            startedPayload.runId,
            record.tensor,
            response.files,
            attachmentIds,
          )
          const accessor = createDataTensorAccessor(schema, tensor, `RecordedData ${record.name}`)
          totalRecordedBytes += accessor.byteLength
          if (totalRecordedBytes > RECORDED_LIMIT_BYTES) {
            throw new CaeSimulationError('resource_limit', 'RecordedData raw bytes가 64 MiB를 초과했습니다.')
          }
          records[record.name] = tensor
          recordSequences.push(record.sequence)
          options.callbacks?.onRecord?.(record.name, tensor)
          ackSequence = record.sequence
          continue
        }
        if (response.files.length > 0) {
          throw new CaeSimulationError('protocol_error', 'terminal 응답은 attachment를 포함할 수 없습니다.')
        }
        const expectedTerminalSequence = (ackSequence ?? 0) + 1
        if (payload.sequence !== expectedTerminalSequence) {
          throw new CaeSimulationError('protocol_error', 'CAE terminal sequence가 record ACK 다음 값이 아닙니다.')
        }
        if (payload.kind === 'failed') {
          await jobSession.finish({ timeoutMs: FINISH_TIMEOUT_MS })
          transportSucceeded = true
          throw new CaeSimulationError(payload.error.code, payload.error.message)
        }
        if (
          payload.recordSequences.length !== recordSequences.length ||
          payload.recordSequences.some((sequence, index) => sequence !== recordSequences[index])
        ) {
          throw new CaeSimulationError('protocol_error', 'terminal record sequence 목록이 수신 캐시와 다릅니다.')
        }
        if (
          payload.provenance.programHash !== manifest.programHash ||
          payload.provenance.recordedDataSchemaHash !== manifest.recordedDataSchemaHash
        ) {
          throw new CaeSimulationError('protocol_error', 'CAE terminal provenance hash가 요청 manifest와 다릅니다.')
        }
        await jobSession.finish({ timeoutMs: FINISH_TIMEOUT_MS })
        transportSucceeded = true
        return buildSimulationResult(
          startedPayload.runId,
          options.sample,
          options.setup,
          records,
          payload,
        )
      }
    } catch (error) {
      releaseDataTensorAttachments(attachmentIds)
      if (!transportSucceeded) await kill()
      session?.close()
      throw error
    }
  })()

  return Object.freeze({ cancel, promise })
}

export function releaseRecordedDataAttachments(recordedData: RecordedData | null): void {
  if (!recordedData) return
  const ids = Object.values(recordedData).flatMap((tensor) =>
    'storage' in tensor && tensor.storage.kind === 'attachments' ? [...tensor.storage.ids] : [],
  )
  releaseDataTensorAttachments(ids)
}

function serializeCaeRequest(sample: BuiltSample, setup: BuiltSetup) {
  const attachments: RequestAttachment[] = []
  let totalBytes = 0
  const visit = (value: unknown, path: string): unknown => {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      if (!LITTLE_ENDIAN) {
        throw new CaeSimulationError('unsupported_platform', 'CAE raw tensor 전송은 little-endian browser가 필요합니다.')
      }
      const typedArray = value as ArrayBufferView & Readonly<{ BYTES_PER_ELEMENT: number }>
      const source = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength)
      const ids: string[] = []
      for (let offset = 0; offset < source.byteLength; offset += SHARD_BYTES) {
        const id = `input-${attachments.length}`
        const bytes = source.slice(offset, Math.min(offset + SHARD_BYTES, source.byteLength))
        ids.push(id)
        attachments.push({
          id,
          name: `${path}.${ids.length - 1}.bin`,
          mimeType: 'application/octet-stream',
          blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' }),
        })
      }
      totalBytes += source.byteLength
      return {
        shape: [typedArray.byteLength / typedArray.BYTES_PER_ELEMENT],
        storage: { kind: 'attachments', ids, byteLength: source.byteLength },
      }
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}.${index}`))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item, `${path}.${key}`)]),
      )
    }
    return value
  }
  const payload = visit({ sample, setup }, 'cae') as Readonly<{ sample: BuiltSample; setup: BuiltSetup }>
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
  totalBytes += payloadBytes.byteLength
  if (totalBytes > INPUT_LIMIT_BYTES) {
    throw new CaeSimulationError('resource_limit', 'BuiltSample/BuiltSetup이 256 MiB를 초과했습니다.')
  }
  if (payloadBytes.byteLength > INLINE_CALL_PAYLOAD_BYTES) {
    const ids: string[] = []
    for (let offset = 0; offset < payloadBytes.byteLength; offset += SHARD_BYTES) {
      const id = `input-${attachments.length}`
      const bytes = payloadBytes.slice(offset, Math.min(offset + SHARD_BYTES, payloadBytes.byteLength))
      ids.push(id)
      attachments.push({
        id,
        name: `cae-start.${ids.length - 1}.json`,
        mimeType: 'application/json; charset=utf-8',
        blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/json' }),
      })
    }
    return Object.freeze({
      payload: Object.freeze({
        kind: 'cae.start.payload-attachments',
        storage: Object.freeze({
          kind: 'attachments',
          ids: Object.freeze(ids),
          byteLength: payloadBytes.byteLength,
        }),
      }),
      attachments,
    })
  }
  return Object.freeze({ payload, attachments })
}

async function cacheRecordAttachments(
  runId: string,
  tensor: DataTensor,
  files: readonly Readonly<{ id: string; blob: Blob; size: number }>[],
  registeredIds: string[],
): Promise<DataTensor> {
  if (tensor.storage.kind !== 'attachments') {
    if (files.length > 0) throw new CaeSimulationError('protocol_error', 'inline tensor에 attachment가 포함됐습니다.')
    return tensor
  }
  if (new Set(tensor.storage.ids).size !== tensor.storage.ids.length) {
    throw new CaeSimulationError('protocol_error', 'tensor attachment id가 중복되었습니다.')
  }
  const byId = new Map(files.map((file) => [file.id, file]))
  if (byId.size !== tensor.storage.ids.length || files.length !== tensor.storage.ids.length) {
    throw new CaeSimulationError('protocol_error', 'tensor attachment 수가 metadata와 다릅니다.')
  }
  let byteLength = 0
  const ids: string[] = []
  for (const id of tensor.storage.ids) {
    const file = byId.get(id)
    if (!file) throw new CaeSimulationError('protocol_error', `tensor attachment가 없습니다: ${id}`)
    if (file.size > SHARD_BYTES) {
      throw new CaeSimulationError('resource_limit', `tensor attachment ${id}가 16 MiB를 초과했습니다.`)
    }
    const scopedId = `${runId}:${id}`
    const bytes = await file.blob.arrayBuffer()
    registerDataTensorAttachment(scopedId, bytes)
    registeredIds.push(scopedId)
    ids.push(scopedId)
    byteLength += bytes.byteLength
  }
  if (byteLength !== tensor.storage.byteLength) {
    throw new CaeSimulationError('protocol_error', 'tensor byteLength가 attachment bytes와 다릅니다.')
  }
  return Object.freeze({
    ...tensor,
    storage: Object.freeze({
      kind: 'attachments' as const,
      ids: Object.freeze(ids),
      byteLength,
    }),
  })
}

function assertStarted(
  payload: unknown,
  programHash: string,
  schemaHash: string,
): asserts payload is Extract<StartPayload, { kind: 'started' }> {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      'kind',
      'runId',
      'programHash',
      'recordedDataSchemaHash',
      'maxRunSeconds',
    ]) ||
    payload.kind !== 'started' ||
    typeof payload.runId !== 'string' ||
    !payload.runId ||
    payload.programHash !== programHash ||
    payload.recordedDataSchemaHash !== schemaHash ||
    typeof payload.maxRunSeconds !== 'number' ||
    !Number.isSafeInteger(payload.maxRunSeconds) ||
    payload.maxRunSeconds < 1 ||
    payload.maxRunSeconds > 2 * 60 * 60
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE started payload 또는 program/schema hash가 올바르지 않습니다.')
  }
}

function assertNextPayload(
  payload: unknown,
  manifest: SimulationProgramManifest,
): asserts payload is RecordPayload | CompletePayload | FailedPayload {
  if (!isRecord(payload)) {
    throw new CaeSimulationError('protocol_error', 'CAE next payload가 객체가 아닙니다.')
  }
  if (payload.kind === 'failed') {
    assertFailedPayload(payload)
    return
  }
  if (payload.kind === 'record') {
    if (
      !hasExactKeys(payload, ['kind', 'sequence', 'name', 'tensor']) ||
      !Number.isSafeInteger(payload.sequence) ||
      (payload.sequence as number) < 1 ||
      typeof payload.name !== 'string' ||
      !payload.name ||
      !isRecord(payload.tensor)
    ) {
      throw new CaeSimulationError('protocol_error', 'CAE record payload가 올바르지 않습니다.')
    }
    return
  }
  if (payload.kind !== 'complete') {
    throw new CaeSimulationError('protocol_error', '알 수 없는 CAE next payload입니다.')
  }
  if (
    !hasExactKeys(payload, [
      'kind',
      'sequence',
      'recordSequences',
      'trace',
      'provenance',
      'finalStateRevision',
      'finalState',
    ]) ||
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 1 ||
    !Array.isArray(payload.recordSequences) ||
    payload.recordSequences.some(
      (sequence) => !Number.isSafeInteger(sequence) || (sequence as number) < 1,
    ) ||
    !Array.isArray(payload.trace) ||
    !isRecord(payload.provenance) ||
    !Number.isSafeInteger(payload.finalStateRevision) ||
    (payload.finalStateRevision as number) < 0
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE complete payload가 올바르지 않습니다.')
  }
  const provenance = payload.provenance
  if (
    !hasExactKeys(provenance, [
      'programHash',
      'recordedDataSchemaHash',
      'simulationApiVersion',
      'durationMs',
    ]) ||
    typeof provenance.programHash !== 'string' ||
    typeof provenance.recordedDataSchemaHash !== 'string' ||
    String(provenance.simulationApiVersion) !== String(manifest.simulationApiVersion) ||
    !Number.isSafeInteger(provenance.durationMs) ||
    (provenance.durationMs as number) < 0
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE complete provenance가 올바르지 않습니다.')
  }
  payload.trace.forEach((entry, index) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'task',
        'kernel',
        'inputStateRevision',
        'outputStateRevision',
        'inputArtifacts',
        'status',
        'startedAt',
        'finishedAt',
        'durationMs',
        'observations',
      ]) ||
      typeof entry.task !== 'string' ||
      !entry.task ||
      !isRecord(entry.kernel) ||
      !hasExactKeys(entry.kernel, ['name', 'version', 'descriptorHash']) ||
      typeof entry.kernel.name !== 'string' ||
      typeof entry.kernel.version !== 'string' ||
      typeof entry.kernel.descriptorHash !== 'string' ||
      !Number.isSafeInteger(entry.inputStateRevision) ||
      (entry.inputStateRevision as number) < 0 ||
      !Number.isSafeInteger(entry.outputStateRevision) ||
      (entry.outputStateRevision as number) < 0 ||
      !isRecord(entry.inputArtifacts) ||
      entry.status !== 'succeeded' ||
      !Number.isSafeInteger(entry.startedAt) ||
      !Number.isSafeInteger(entry.finishedAt) ||
      (entry.startedAt as number) < 0 ||
      (entry.finishedAt as number) < (entry.startedAt as number) ||
      !Number.isSafeInteger(entry.durationMs) ||
      (entry.durationMs as number) < 0 ||
      !isRecord(entry.observations)
    ) {
      throw new CaeSimulationError('protocol_error', `CAE trace entry ${index + 1}이 올바르지 않습니다.`)
    }
    Object.entries(entry.inputArtifacts).forEach(([port, rawArtifact]) => {
      if (!port || (Array.isArray(rawArtifact) ? rawArtifact : [rawArtifact]).some((artifact) => {
        return (
          !isRecord(artifact) ||
          !hasExactKeys(artifact, ['id', 'artifactType']) ||
          typeof artifact.id !== 'string' ||
          !artifact.id ||
          typeof artifact.artifactType !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._/-]*@[1-9][0-9]*$/u.test(artifact.artifactType)
        )
      })) {
        throw new CaeSimulationError(
          'protocol_error',
          `CAE trace entry ${index + 1}의 inputArtifacts가 올바르지 않습니다.`,
        )
      }
    })
    const task = manifest.tasks[entry.task]
    if (
      !task ||
      entry.kernel.name !== task.kernel.name ||
      entry.kernel.version !== task.kernel.version ||
      entry.kernel.descriptorHash !== task.kernel.descriptorHash
    ) {
      throw new CaeSimulationError(
        'protocol_error',
        `CAE trace entry ${index + 1}의 task/kernel이 manifest와 다릅니다.`,
      )
    }
  })
  assertJsonValue(payload.finalState, 'CAE finalState')
}

function assertFailedPayload(payload: unknown): asserts payload is FailedPayload {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['kind', 'sequence', 'error']) ||
    payload.kind !== 'failed' ||
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 0 ||
    !isRecord(payload.error) ||
    !hasExactKeys(payload.error, ['code', 'message']) ||
    typeof payload.error.code !== 'string' ||
    !payload.error.code ||
    typeof payload.error.message !== 'string' ||
    !payload.error.message
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE failed payload가 올바르지 않습니다.')
  }
}

function assertJsonValue(value: unknown, path: string, depth = 0): void {
  if (depth > 64) throw new CaeSimulationError('protocol_error', `${path} 깊이가 너무 큽니다.`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CaeSimulationError('protocol_error', `${path}에 finite하지 않은 값이 있습니다.`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, depth + 1))
    return
  }
  if (!isRecord(value)) {
    throw new CaeSimulationError('protocol_error', `${path}가 JSON 값이 아닙니다.`)
  }
  Object.entries(value).forEach(([key, item]) =>
    assertJsonValue(item, `${path}.${key}`, depth + 1),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function handleEvent(event: JobEvent, runId: string, callbacks: RemoteCaeCallbacks | undefined): void {
  if (event.type === 'status') {
    const status =
      event.payload && typeof event.payload === 'object' && 'status' in event.payload
        ? String(event.payload.status)
        : ''
    if (status === 'validating' || status === 'running' || status === 'finalizing') callbacks?.onStatus?.(status)
    return
  }
  if (event.type !== 'progress' || !event.payload || typeof event.payload !== 'object') return
  const progress = event.payload as Partial<SimulationProgress>
  if (
    typeof progress.stage !== 'string' ||
    typeof progress.completed !== 'number' ||
    !Number.isFinite(progress.completed)
  ) {
    return
  }
  callbacks?.onProgress?.(
    Object.freeze({
      runId,
      task: typeof progress.task === 'string' ? progress.task : 'simulation',
      kernel:
        progress.kernel &&
        typeof progress.kernel.name === 'string' &&
        typeof progress.kernel.version === 'string'
          ? progress.kernel
          : Object.freeze({ name: 'cae', version: '1' }),
      stage: progress.stage,
      completed: progress.completed,
      ...(typeof progress.total === 'number' ? { total: progress.total } : {}),
      ...(typeof progress.message === 'string' ? { message: progress.message } : {}),
    }),
  )
}

function buildSimulationResult(
  runId: string,
  sample: BuiltSample,
  setup: BuiltSetup,
  records: Readonly<Record<string, DataTensor>>,
  terminal: CompletePayload,
): SimulationResult {
  const manifest = setup.experiment.simulationProgram!
  const trace = Object.freeze(
    terminal.trace.map((entry, index) => {
      const inputArtifacts = Object.freeze(
        Object.fromEntries(
          Object.entries(entry.inputArtifacts).map(([name, rawArtifact]) => [
            name,
            Array.isArray(rawArtifact)
              ? Object.freeze(
                  rawArtifact.map(
                    (artifact) =>
                      Object.freeze({
                        ...artifact,
                        artifactType: artifact.artifactType as SimulationTraceArtifact['artifactType'],
                      }) satisfies SimulationTraceArtifact,
                  ),
                )
              : Object.freeze({
                  ...(rawArtifact as Readonly<{ id: string; artifactType: string }>),
                  artifactType: (rawArtifact as Readonly<{ artifactType: string }>).artifactType as
                    SimulationTraceArtifact['artifactType'],
                }) satisfies SimulationTraceArtifact,
          ]),
        ),
      ) as SimulationTraceEntry['inputArtifacts']
      return Object.freeze({
        sequence: index + 1,
        task: entry.task,
        kernel: Object.freeze({
          name: entry.kernel.name,
          version: entry.kernel.version,
        }),
        inputStateRevision: entry.inputStateRevision,
        outputStateRevision: entry.outputStateRevision,
        inputArtifacts,
        status: entry.status,
        startedAt: entry.startedAt,
        finishedAt: entry.finishedAt,
      }) satisfies SimulationTraceEntry
    }),
  )
  const kernels = Object.freeze(
    [
      ...new Map(
        trace.map((entry) => [
          `${entry.kernel.name}\u0000${entry.kernel.version}`,
          entry.kernel,
        ]),
      ).values(),
    ],
  )
  return Object.freeze({
    format: 'caemble-run',
    formatVersion: 1,
    runId,
    finalStateRevision: terminal.finalStateRevision,
    recordedData: Object.freeze(
      Object.fromEntries(
        Object.entries(records).map(([name, data]) => [
          name,
          Object.freeze({ spec: manifest.recordedData[name], data }),
        ]),
      ),
    ),
    trace,
    provenance: Object.freeze({
      programHash: manifest.programHash,
      structureSourceHash: sample.structure.sourceHash,
      experimentSourceHash: setup.experiment.sourceHash,
      structureSeed: sample.structure.seed,
      experimentSeed: setup.experiment.seed,
      structureVars: sample.structure.variables,
      experimentVars: setup.experiment.variables,
      kernels,
    }),
  })
}

function abortError() {
  const error = new Error('Simulation run was cancelled.')
  error.name = 'AbortError'
  return error
}
