import { GpStationClient, type CallResult, type JobEvent, type JobSession } from '@gpstation/v1-master-js-sdk'
import type {
  CaeCompletePayload,
  CaeFailedPayload,
  CaeNextRequest,
  CaeRecordPayload,
  CaeSimulationProgress,
  CaeSimulationStatus,
  CaeStartedPayload,
} from './protocol'
import { CaeSimulationError } from './errors'
import { serializeCaeRequest } from './request'
import { API_URL } from '@/api'
import { request as apiRequest } from '@/api/http'
import type { BuiltMeasurement, DataTensor, RecordedData } from '../../lib/cad'
import { createDataTensorAccessor, registerDataTensorAttachment, releaseDataTensorAttachments } from '../../lib/cad'
import { sourceCatalogSolverContracts } from '@/lib/catalog/runtime'

const RECORDED_LIMIT_BYTES = 64 * 1024 * 1024
const SHARD_BYTES = 16 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 60_000
const FINISH_TIMEOUT_MS = 60_000

export type CaeSimulationOptions = Readonly<{
  signal?: AbortSignal
  onRecord?: (name: string, tensor: DataTensor) => void
  onStatus?: (status: CaeSimulationStatus) => void
  onProgress?: (progress: CaeSimulationProgress) => void
}>

type StartPayload = CaeStartedPayload | CaeFailedPayload
type NextPayload = CaeRecordPayload | CaeCompletePayload | CaeFailedPayload

export { CaeSimulationError } from './errors'

export function simulate(
  measurement: BuiltMeasurement,
  options: CaeSimulationOptions = {},
): Promise<RecordedData> {
  let cancelled = options.signal?.aborted ?? false
  let jobId: string | null = null
  let session: JobSession | null = null
  const attachmentIds: string[] = []

  const kill = async () => {
    if (!jobId) return
    try {
      await apiRequest<unknown>('post', `/web/jobs/${encodeURIComponent(jobId)}/kill`)
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
  options.signal?.addEventListener('abort', cancel, { once: true })

  const promise = (async () => {
    if (cancelled) throw abortError()
    const manifest = measurement.experiment.simulationProgram
    if (!manifest || manifest.formatVersion !== 5) {
      throw new CaeSimulationError('program_required', 'Python simulationProgram v5가 필요합니다.')
    }
    const request = serializeCaeRequest(
      measurement,
      sourceCatalogSolverContracts(measurement.experiment.sourceHash),
    )
    const requestAttachments = request.attachments.map(({ bytes, ...attachment }) => ({
      ...attachment,
      blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: attachment.mimeType }),
    }))
    const client = new GpStationClient({
      apiBaseUrl: API_URL,
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    })
    let transportSucceeded = false
    try {
      const started = await client.runJob<unknown, StartPayload>('cae.simulation.start', request.payload, {
        slaveAppId: 'cae',
        autoFinish: false,
        timeoutMs: CONNECT_TIMEOUT_MS,
        attachments: requestAttachments,
        onJobCreated(job) {
          jobId = job.id
          if (cancelled) void kill()
        },
      })
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
      assertStarted(startedPayload)

      const records: Record<string, DataTensor> = {}
      const recordSequences: number[] = []
      let ackSequence: number | null = null
      let totalRecordedBytes = 0
      while (true) {
        if (cancelled) throw abortError()
        const response: CallResult<unknown> = await jobSession.call<CaeNextRequest, unknown>(
          'cae.simulation.next',
          { runId: startedPayload.runId, ackSequence },
          {
            timeoutMs: (startedPayload.maxRunSeconds + 5 * 60) * 1000,
            onEvent: (event) => handleEvent(event, startedPayload.runId, options),
          },
        )
        const payload = response.payload
        assertNextPayload(payload)
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
          options.onRecord?.(record.name, tensor)
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
        await jobSession.finish({ timeoutMs: FINISH_TIMEOUT_MS })
        transportSucceeded = true
        return Object.freeze(records)
      }
    } catch (error) {
      releaseDataTensorAttachments(attachmentIds)
      if (!transportSucceeded) await kill()
      session?.close()
      throw error
    }
  })()

  return promise.finally(() => {
    options.signal?.removeEventListener('abort', cancel)
  })
}

export function releaseRecordedDataAttachments(recordedData: RecordedData | null): void {
  if (!recordedData) return
  const ids = Object.values(recordedData).flatMap((tensor) =>
    'storage' in tensor && tensor.storage.kind === 'attachments' ? [...tensor.storage.ids] : [],
  )
  releaseDataTensorAttachments(ids)
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

function assertStarted(payload: unknown): asserts payload is CaeStartedPayload {
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, ['kind', 'runId', 'maxRunSeconds']) ||
    payload.kind !== 'started' ||
    typeof payload.runId !== 'string' ||
    !payload.runId ||
    typeof payload.maxRunSeconds !== 'number' ||
    !Number.isSafeInteger(payload.maxRunSeconds) ||
    payload.maxRunSeconds < 1 ||
    payload.maxRunSeconds > 2 * 60 * 60
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE started payload가 올바르지 않습니다.')
  }
}

function assertNextPayload(payload: unknown): asserts payload is NextPayload {
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
    !hasExactKeys(payload, ['kind', 'sequence', 'recordSequences']) ||
    !Number.isSafeInteger(payload.sequence) ||
    (payload.sequence as number) < 1 ||
    !Array.isArray(payload.recordSequences) ||
    payload.recordSequences.some((sequence) => !Number.isSafeInteger(sequence) || (sequence as number) < 1)
  ) {
    throw new CaeSimulationError('protocol_error', 'CAE complete payload가 올바르지 않습니다.')
  }
}

function assertFailedPayload(payload: unknown): asserts payload is CaeFailedPayload {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function handleEvent(event: JobEvent, runId: string, callbacks: CaeSimulationOptions): void {
  if (event.type === 'status') {
    const status =
      event.payload && typeof event.payload === 'object' && 'status' in event.payload
        ? String(event.payload.status)
        : ''
    if (status === 'validating' || status === 'running' || status === 'finalizing') callbacks?.onStatus?.(status)
    return
  }
  if (event.type !== 'progress' || !event.payload || typeof event.payload !== 'object') return
  const progress = event.payload as Partial<CaeSimulationProgress>
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
        progress.kernel && typeof progress.kernel.name === 'string' && typeof progress.kernel.version === 'string'
          ? progress.kernel
          : Object.freeze({ name: 'cae', version: '1' }),
      stage: progress.stage,
      completed: progress.completed,
      ...(typeof progress.total === 'number' ? { total: progress.total } : {}),
      ...(typeof progress.message === 'string' ? { message: progress.message } : {}),
    }),
  )
}

function abortError() {
  const error = new Error('Simulation run was cancelled.')
  error.name = 'AbortError'
  return error
}
