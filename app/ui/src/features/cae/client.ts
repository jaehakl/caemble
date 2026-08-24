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
import { emitRuntimeActivity, type RuntimeActivityCallback } from '@/features/runtime-console/types'
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
  onActivity?: RuntimeActivityCallback
}>

type StartPayload = CaeStartedPayload | CaeFailedPayload
type NextPayload = CaeRecordPayload | CaeCompletePayload | CaeFailedPayload

export { CaeSimulationError } from './errors'

export function simulate(measurement: BuiltMeasurement, options: CaeSimulationOptions = {}): Promise<RecordedData> {
  let cancelled = options.signal?.aborted ?? false
  let jobId: string | null = null
  let runId: string | null = null
  let session: JobSession | null = null
  let failureReported = false
  const attachmentIds: string[] = []
  const report = (activity: Parameters<RuntimeActivityCallback>[0]) => emitRuntimeActivity(options.onActivity, activity)

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
    report({
      source: 'gpstation',
      level: 'warning',
      phase: 'job.cancel.requested',
      message: 'GPStation Job 취소를 요청했습니다.',
      ...(jobId ? { jobId } : {}),
      ...(runId ? { runId } : {}),
    })
    void kill()
    session?.close()
    releaseDataTensorAttachments(attachmentIds)
  }
  options.signal?.addEventListener('abort', cancel, { once: true })

  const promise = (async () => {
    if (cancelled) throw abortError()
    const manifest = measurement.experiment.simulationProgram
    if (!manifest || manifest.formatVersion !== 5 || Object.keys(manifest.tasks).length === 0) {
      report({
        source: 'cae',
        level: 'error',
        phase: 'request.rejected',
        message: '실행 가능한 Python simulation program이 없습니다.',
      })
      throw new CaeSimulationError('program_required', 'Python simulationProgram v5가 필요합니다.')
    }
    const request = serializeCaeRequest(measurement, sourceCatalogSolverContracts(measurement.experiment.sourceHash))
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
      report({
        source: 'gpstation',
        level: 'info',
        phase: 'job.requested',
        message: 'CAE Job을 GPStation에 요청했습니다.',
        details: { handler: 'cae.simulation.start', attachmentCount: requestAttachments.length },
      })
      const started = await client.runJob<unknown, StartPayload>('cae.simulation.start', request.payload, {
        slaveAppId: 'cae',
        autoFinish: false,
        timeoutMs: CONNECT_TIMEOUT_MS,
        attachments: requestAttachments,
        onJobCreated(job) {
          jobId = job.id
          report({
            source: 'gpstation',
            level: 'info',
            phase: 'job.created',
            message: 'GPStation Job이 생성되었습니다.',
            jobId,
          })
          if (cancelled) void kill()
        },
      })
      const jobSession = started.session
      session = jobSession
      jobId ??= jobSession.jobId
      report({
        source: 'gpstation',
        level: 'info',
        phase: 'job.connected',
        message: 'GPStation worker session에 연결되었습니다.',
        jobId,
      })
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
        failureReported = true
        report({
          source: 'cae',
          level: 'error',
          phase: 'run.failed',
          message: startedPayload.error.message,
          jobId,
          details: { code: startedPayload.error.code },
        })
        throw new CaeSimulationError(startedPayload.error.code, startedPayload.error.message)
      }
      assertStarted(startedPayload)
      runId = startedPayload.runId
      report({
        source: 'cae',
        level: 'info',
        phase: 'run.started',
        message: 'CAE 실행이 시작되었습니다.',
        jobId,
        runId,
        details: { maxRunSeconds: startedPayload.maxRunSeconds },
      })

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
            onEvent: (event) => handleEvent(event, startedPayload.runId, jobId, options),
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
          report({
            source: 'cae',
            level: 'info',
            phase: 'record.received',
            message: `Recorded Data ${record.name}을 수신했습니다.`,
            jobId,
            runId,
            details: { name: record.name, sequence: record.sequence, byteLength: accessor.byteLength },
          })
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
          failureReported = true
          report({
            source: 'cae',
            level: 'error',
            phase: 'run.failed',
            message: payload.error.message,
            jobId,
            runId,
            details: { code: payload.error.code, sequence: payload.sequence },
          })
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
        report({
          source: 'cae',
          level: 'info',
          phase: 'run.completed',
          message: 'CAE 실행이 완료되었습니다.',
          jobId,
          runId,
          details: { recordCount: recordSequences.length },
        })
        report({
          source: 'gpstation',
          level: 'info',
          phase: 'job.finished',
          message: 'GPStation Job session을 종료했습니다.',
          jobId,
          runId,
        })
        return Object.freeze(records)
      }
    } catch (error) {
      releaseDataTensorAttachments(attachmentIds)
      if (!transportSucceeded) await kill()
      session?.close()
      if (!failureReported) {
        report({
          source: cancelled || (error instanceof Error && error.name === 'AbortError') ? 'gpstation' : 'cae',
          level: cancelled || (error instanceof Error && error.name === 'AbortError') ? 'warning' : 'error',
          phase:
            cancelled || (error instanceof Error && error.name === 'AbortError') ? 'job.cancelled' : 'client.failed',
          message:
            cancelled || (error instanceof Error && error.name === 'AbortError')
              ? 'GPStation Job session이 취소되었습니다.'
              : error instanceof Error
                ? error.message
                : 'CAE client 실행에 실패했습니다.',
          ...(jobId ? { jobId } : {}),
          ...(runId ? { runId } : {}),
          details: { errorName: error instanceof Error ? error.name : 'UnknownError' },
        })
      }
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

function handleEvent(event: JobEvent, runId: string, jobId: string | null, callbacks: CaeSimulationOptions): void {
  if (event.type === 'status') {
    const status =
      event.payload && typeof event.payload === 'object' && 'status' in event.payload
        ? String(event.payload.status)
        : ''
    if (status === 'validating' || status === 'running' || status === 'finalizing') {
      callbacks.onStatus?.(status)
      emitRuntimeActivity(callbacks.onActivity, {
        source: 'cae',
        level: 'info',
        phase: `status.${status}`,
        message: `CAE 실행 상태: ${status}`,
        ...(jobId ? { jobId } : {}),
        runId,
      })
    }
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
  const normalized = Object.freeze({
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
  })
  callbacks.onProgress?.(normalized)
  emitRuntimeActivity(callbacks.onActivity, {
    id: `cae-progress:${runId}:${normalized.task}`,
    source: 'cae',
    level: 'info',
    phase: 'run.progress',
    message: `${normalized.task}: ${normalized.stage}`,
    ...(jobId ? { jobId } : {}),
    runId,
    ...(typeof normalized.total === 'number' && normalized.total > 0
      ? { progress: normalized.completed / normalized.total }
      : {}),
    details: {
      task: normalized.task,
      stage: normalized.stage,
      kernel: `${normalized.kernel.name}@${normalized.kernel.version}`,
      completed: normalized.completed,
      ...(typeof normalized.total === 'number' ? { total: normalized.total } : {}),
    },
  })
}

function abortError() {
  const error = new Error('Simulation run was cancelled.')
  error.name = 'AbortError'
  return error
}
