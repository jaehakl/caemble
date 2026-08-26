import {
  GpStationClient,
  type CallResult,
  type ConnectDiagnosticEvent,
  type JobEvent,
  type JobSession,
} from '@gpstation/v1-master-js-sdk'
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
import {
  emitRuntimeActivity,
  type RuntimeActivityCallback,
  type RuntimeActivityDetails,
} from '@/features/runtime-console/types'
import type {
  BuiltMeasurement,
  DataTensor,
  RecordedData,
  RecordedDataNode,
} from '../../lib/cad'
import { registerDataTensorAttachment, releaseDataTensorAttachments } from '../../lib/cad'

const CONNECT_TIMEOUT_MS = 60_000
const FINISH_TIMEOUT_MS = 60_000

export type CaeSimulationOptions = Readonly<{
  signal?: AbortSignal
  onRecord?: (name: string, value: RecordedDataNode) => void
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
  const transportState: { lastDiagnostic?: ConnectDiagnosticEvent } = {}
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
    const request = serializeCaeRequest(measurement)
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
        onDiagnostic(event) {
          transportState.lastDiagnostic = event
          const failed =
            event.message.endsWith(': error') ||
            event.connectionState === 'failed' ||
            event.iceConnectionState === 'failed'
          const interrupted =
            event.dataChannelState === 'closing' ||
            event.dataChannelState === 'closed' ||
            event.connectionState === 'disconnected' ||
            event.connectionState === 'closed'
          report({
            source: 'gpstation',
            level: failed ? 'error' : interrupted ? 'warning' : 'info',
            phase: `transport.${event.stage}`,
            message: event.message,
            ...(jobId ? { jobId } : {}),
            ...(runId ? { runId } : {}),
            details: transportDiagnosticDetails(event),
          })
        },
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
      const startedPayload = started.payload as StartPayload
      if (startedPayload.kind === 'failed') {
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

      const records: Record<string, RecordedDataNode> = {}
      const recordSequences: number[] = []
      let ackSequence: number | null = null
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
        const payload = response.payload as NextPayload
        if (payload.kind === 'record') {
          const record = payload
          const schema = manifest.recordedData[record.name]
          const cached = await cacheRecordValue(
            startedPayload.runId,
            record.value,
            response.files,
            attachmentIds,
          )
          void schema
          records[record.name] = cached.value
          recordSequences.push(record.sequence)
          options.onRecord?.(record.name, cached.value)
          report({
            source: 'cae',
            level: 'info',
            phase: 'record.received',
            message: `Recorded Data ${record.name}을 수신했습니다.`,
            jobId,
            runId,
            details: { name: record.name, sequence: record.sequence, byteLength: cached.byteLength },
          })
          ackSequence = record.sequence
          continue
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
        const lastTransportDiagnostic = transportState.lastDiagnostic
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
          details: {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            ...(lastTransportDiagnostic
              ? {
                  lastTransportStage: lastTransportDiagnostic.stage,
                  ...(lastTransportDiagnostic.connectionState
                    ? { lastConnectionState: lastTransportDiagnostic.connectionState }
                    : {}),
                  ...(lastTransportDiagnostic.iceConnectionState
                    ? { lastIceConnectionState: lastTransportDiagnostic.iceConnectionState }
                    : {}),
                  ...(lastTransportDiagnostic.dataChannelState
                    ? { lastDataChannelState: lastTransportDiagnostic.dataChannelState }
                    : {}),
                  ...(lastTransportDiagnostic.bufferedAmount !== undefined
                    ? { lastBufferedAmount: lastTransportDiagnostic.bufferedAmount }
                    : {}),
                }
              : {}),
          },
        })
      }
      throw error
    }
  })()

  return promise.finally(() => {
    options.signal?.removeEventListener('abort', cancel)
  })
}

function transportDiagnosticDetails(event: ConnectDiagnosticEvent): RuntimeActivityDetails {
  const details: Record<string, string | number | boolean | null> = {}
  const scalarFields = [
    'callId',
    'attachmentCount',
    'attachmentBytes',
    'bufferedAmount',
    'elapsedMs',
    'stageStartedAt',
    'prewarmHit',
    'offerGatheringMs',
    'answerWaitMs',
    'dataChannelOpenMs',
    'signalingState',
    'iceGatheringState',
    'iceConnectionState',
    'connectionState',
    'dataChannelState',
  ] as const
  for (const field of scalarFields) {
    const value = event[field]
    if (value !== undefined) details[field] = value
  }
  for (const [prefix, summary] of [
    ['localCandidate', event.localCandidateSummary],
    ['remoteCandidate', event.remoteCandidateSummary],
  ] as const) {
    if (!summary) continue
    details[`${prefix}Total`] = summary.total
    details[`${prefix}Host`] = summary.host
    details[`${prefix}Srflx`] = summary.srflx
    details[`${prefix}Relay`] = summary.relay
    details[`${prefix}Prflx`] = summary.prflx
    details[`${prefix}Unknown`] = summary.unknown
  }
  return details
}

export function releaseRecordedDataAttachments(recordedData: RecordedData | null): void {
  if (!recordedData) return
  const ids: string[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    if ('storage' in value && 'shape' in value) {
      const tensor = value as DataTensor
      if (tensor.storage.kind === 'attachments') ids.push(...tensor.storage.ids)
      return
    }
    if ('value' in value && (typeof value.value !== 'object' || value.value === null || Array.isArray(value.value))) return
    Object.values(value).forEach(visit)
  }
  Object.values(recordedData).forEach(visit)
  releaseDataTensorAttachments(ids)
}

async function cacheRecordValue(
  runId: string,
  value: unknown,
  files: readonly Readonly<{ id: string; blob: Blob; size: number }>[],
  registeredIds: string[],
): Promise<Readonly<{ value: RecordedDataNode; byteLength: number }>> {
  const byId = new Map(files.map((file) => [file.id, file]))
  let byteLength = 0
  const visit = async (node: unknown): Promise<RecordedDataNode> => {
    if (node && typeof node === 'object' && !Array.isArray(node) && 'shape' in node && 'storage' in node) {
      const tensor = node as DataTensor
      if (tensor.storage.kind !== 'attachments') return tensor
      const ids: string[] = []
      let tensorBytes = 0
      for (const id of tensor.storage.ids) {
        const file = byId.get(id)!
        const scopedId = `${runId}:${id}`
        const bytes = await file.blob.arrayBuffer()
        registerDataTensorAttachment(scopedId, bytes)
        registeredIds.push(scopedId)
        ids.push(scopedId)
        byteLength += bytes.byteLength
        tensorBytes += bytes.byteLength
      }
      return Object.freeze({
        ...tensor,
        storage: Object.freeze({ kind: 'attachments' as const, ids: Object.freeze(ids), byteLength: tensorBytes }),
      })
    }
    const entries: [string, RecordedDataNode][] = []
    for (const [name, member] of Object.entries(node as Record<string, unknown>)) {
      entries.push([name, await visit(member)])
    }
    return Object.freeze(Object.fromEntries(entries))
  }
  return Object.freeze({ value: await visit(value), byteLength })
}

function handleEvent(event: JobEvent, runId: string, jobId: string | null, callbacks: CaeSimulationOptions): void {
  if (event.type === 'status') {
    const status = (event.payload as { status: CaeSimulationStatus }).status
    callbacks.onStatus?.(status)
    emitRuntimeActivity(callbacks.onActivity, {
      source: 'cae',
      level: 'info',
      phase: `status.${status}`,
      message: `CAE 실행 상태: ${status}`,
      ...(jobId ? { jobId } : {}),
      runId,
    })
    return
  }
  if (event.type !== 'progress') return
  const progress = event.payload as CaeSimulationProgress
  const normalized = Object.freeze({
    runId,
    task: progress.task,
    kernel: progress.kernel,
    stage: progress.stage,
    completed: progress.completed,
    ...(progress.total === undefined ? {} : { total: progress.total }),
    ...(progress.message === undefined ? {} : { message: progress.message }),
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
