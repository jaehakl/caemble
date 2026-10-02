import { GpStationClient, type JobSession } from '@gpstation/v1-master-js-sdk'
import { z } from 'zod'
import { browserClient } from '@/api/http'
import { describeResourceWait } from '@/features/runtime/resources'
import { predictionApi } from '@/api/prediction'
import {
  PredictionInstanceInvalidatedError,
  type PredictionExecution,
  type PredictionInput,
  type PredictionModelInstance,
  type PredictionRequest,
  type SavedPredictionModel,
  type PredictionExecutionRoute,
} from './execution'
import {
  parseRemoteEnvelope,
  RemotePredictionError,
  remoteHelloSchema,
  remotePreparedSchema,
  remoteResultSchema,
  type RemoteHello,
  type RemotePrepared,
} from './remoteProtocol'

export type RemotePredictionState =
  'disconnected' | 'connecting' | 'waiting-resources' | 'reconciling' | 'connected' | 'idle' | 'failed'
export type PredictionTransport = Readonly<{
  connect: (requestId: string, signal?: AbortSignal) => Promise<{ session: JobSession; payload: unknown }>
  cancel: (jobId: string, signal?: AbortSignal) => Promise<void>
}>
type LoadedModel = {
  reference: SavedPredictionModel
  route: PredictionExecutionRoute
  prepared: RemotePrepared
  wire: PredictionModelInstance | null
}
const invalidSessionCodes = new Set(['stale-response', 'model-mismatch', 'storage-mismatch', 'unsupported-execution'])

/** Bound the entire phase, including HTTP auth/registration and late transport replies. */
function withDeadline<T>(
  milliseconds: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  lifetime?: AbortSignal,
): Promise<T> {
  const abort = new AbortController()
  const stop = () => abort.abort(lifetime?.reason)
  if (lifetime?.aborted) stop()
  else lifetime?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(
    () => abort.abort(new DOMException(`${label} 대기 시간이 초과되었습니다. 다시 시도하세요.`, 'TimeoutError')),
    milliseconds,
  )
  return new Promise<T>((resolve, reject) => {
    const interrupted = () => reject(abort.signal.reason)
    if (abort.signal.aborted) return interrupted()
    abort.signal.addEventListener('abort', interrupted, { once: true })
    Promise.resolve()
      .then(() => operation(abort.signal))
      .then(resolve, reject)
      .finally(() => {
        abort.signal.removeEventListener('abort', interrupted)
      })
  }).finally(() => {
    clearTimeout(timer)
    lifetime?.removeEventListener('abort', stop)
  })
}

/** One wire call at a time. Aborting a caller does not break the SDK response/ACK exchange. */
export class RemotePredictionExecution implements PredictionExecution {
  readonly id = 'remote-predictor'
  readonly location = 'remote'
  get algorithms() {
    return this.helloValue?.algorithmDescriptors.map((item) => item.kind) ?? []
  }
  get directions() {
    return [
      ...new Set(
        this.helloValue?.algorithmDescriptors.flatMap((item) =>
          item.directions.filter((direction) => direction === 'forward'),
        ) ?? [],
      ),
    ]
  }
  get representations() {
    return [...new Set(this.helloValue?.algorithmDescriptors.flatMap((item) => item.representations) ?? [])]
  }
  private readonly lifetime = new AbortController()
  private epoch = 0
  private readonly key = crypto.randomUUID()
  private readonly transport: PredictionTransport
  private session: JobSession | null = null
  private connecting: Promise<JobSession> | null = null
  private helloValue: RemoteHello | null = null
  private tail: Promise<void> = Promise.resolve()
  private pending = new Map<string, () => void>()
  private models = new Map<string, LoadedModel>()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private queued = 0
  private disposed = false
  private failed = false
  private stateValue: RemotePredictionState = 'disconnected'
  private latestQueuedPrediction: string | null = null
  private connectingJobId: string | null = null

  constructor(
    readonly launcherId: string,
    private readonly options: {
      transport?: PredictionTransport
      idleMs?: number
      storageId?: string
      algorithm?: string
      modelId?: string
      modelRevision?: number
      onState?: (state: RemotePredictionState, message?: string) => void
      onWarning?: (message: string) => void
      onHello?: (hello: RemoteHello, signal?: AbortSignal) => Promise<void>
    } = {},
  ) {
    const client = new GpStationClient({
      apiBaseUrl: browserClient.baseUrl,
      authMode: 'cookie',
      jobApiPrefix: '/web/jobs',
    })
    this.transport = options.transport ?? {
      connect: async (requestId, signal) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        let finished = false
        const observe = async (jobId: string) => {
          try {
            const job = await browserClient.request('get', `/web/jobs/${encodeURIComponent(jobId)}`, undefined, {
              signal,
              validate: (value) => z.object({ waiting_reason: z.string().nullable().optional() }).parse(value),
            })
            if (!finished && !signal?.aborted) {
              const reason = describeResourceWait(job.waiting_reason)
              this.changeState(reason ? 'waiting-resources' : 'connecting', reason ?? 'Predictor 연결 중')
            }
          } catch {
            // The connection owns errors; optional queue observation must not start another job.
          }
          if (!finished && !signal?.aborted)
            timer = setTimeout(() => {
              void observe(jobId)
            }, 2_000)
        }
        try {
          const algorithms = await predictionApi.algorithms({ signal })
          let kind = this.options.algorithm
          if (!kind) {
            const model = (await predictionApi.models(undefined, { signal })).find(
              (item) => item.id === this.options.modelId,
            )
            const stored = model?.revisions.find((item) => item.revision === this.options.modelRevision)?.definition
              .algorithm as { kind?: unknown } | undefined
            if (typeof stored?.kind === 'string') kind = stored.kind
          }
          const algorithm = algorithms.find((item) => item.kind === kind)
          if (!algorithm?.directions.includes('forward'))
            throw new RemotePredictionError(
              'unsupported-execution',
              '선택한 모델의 Forward 알고리즘을 지원하지 않습니다.',
            )
          return await client.runJob(
            'predictor.hello',
            { protocolVersion: 3, requestId },
            {
              slaveAppId: 'predictor',
              targetLauncherId: launcherId,
              autoFinish: false,
              resources: algorithm.resources.inference,
              timeoutMs: 60_000,
              signal,
              onJobCreated: (job) => {
                this.connectingJobId = job.id
                if (this.disposed || signal?.aborted) void this.cleanupJob(job.id)
                else {
                  const reason = describeResourceWait(job.waiting_reason)
                  if (reason) this.changeState('waiting-resources', reason)
                  timer = setTimeout(() => {
                    void observe(job.id)
                  }, 2_000)
                }
              },
            },
          )
        } finally {
          finished = true
          if (timer) clearTimeout(timer)
        }
      },
      cancel: (jobId, signal) => client.cancelJob(jobId, signal),
    }
  }

  get sessionId() {
    return `${this.key}:${this.epoch}`
  }
  get state() {
    return this.stateValue
  }
  get hello() {
    return this.helloValue
  }

  private changeState(state: RemotePredictionState, message?: string) {
    this.stateValue = state
    this.options.onState?.(state, message)
  }

  private fail(error: unknown) {
    this.lifetime.abort(error)
    const session = this.session
    this.session = null
    session?.close()
    const jobId = session?.jobId ?? this.connectingJobId
    this.connectingJobId = null
    if (jobId) void this.cleanupJob(jobId)
    if (!this.disposed) {
      this.failed = true
      this.changeState('failed', error instanceof Error ? error.message : String(error))
    }
  }

  private async cleanupJob(jobId: string) {
    try {
      await withDeadline(10_000, 'Prediction 자원 정리', (signal) => this.transport.cancel(jobId, signal))
    } catch {
      this.options.onWarning?.('Prediction 자원 정리를 확인하지 못했습니다. Launcher 실행 상태를 확인하세요.')
    }
  }

  private async connect(): Promise<JobSession> {
    if (this.disposed || this.failed)
      throw new PredictionInstanceInvalidatedError('원격 Prediction에 다시 연결하세요.', false)
    if (this.session && !this.session.closed) return this.session
    if (this.session?.closed) {
      this.failed = true
      this.changeState('failed', '원격 Prediction 연결이 끊어졌습니다. 다시 연결하세요.')
      throw new PredictionInstanceInvalidatedError('원격 Prediction 연결이 끊어졌습니다. 다시 연결하세요.', false)
    }
    if (this.connecting) return this.connecting
    const epoch = this.epoch
    const requestId = crypto.randomUUID()
    this.changeState('connecting')
    this.connecting = (async () => {
      const result = await withDeadline(
        60_000,
        'Predictor 연결',
        async (signal) => {
          const connected = await this.transport.connect(requestId, signal)
          if (signal.aborted || this.disposed || epoch !== this.epoch) {
            connected.session.close()
            void this.cleanupJob(connected.session.jobId)
            throw signal.reason ?? new DOMException('Prediction 연결이 취소되었습니다.', 'AbortError')
          }
          return connected
        },
        this.lifetime.signal,
      )
      if (this.disposed || epoch !== this.epoch) {
        result.session.close()
        await this.cleanupJob(result.session.jobId)
        throw new DOMException('Prediction 연결이 취소되었습니다.', 'AbortError')
      }
      this.session = result.session
      this.connectingJobId = null
      const hello = remoteHelloSchema.parse(parseRemoteEnvelope(result.payload, requestId))
      if (
        hello.launcherId !== this.launcherId ||
        (this.options.storageId !== undefined && hello.storageId !== this.options.storageId)
      )
        throw new RemotePredictionError('unsupported-execution', 'Predictor 장비 또는 구현 버전이 요청과 다릅니다.')
      this.helloValue = hello
      if (this.options.onHello) {
        this.changeState('reconciling', '저장 모델 목록 확인 중')
        await withDeadline(
          30_000,
          'Prediction 자산 등록',
          (signal) => this.options.onHello!(hello, signal),
          this.lifetime.signal,
        )
      }
      if (this.disposed || epoch !== this.epoch)
        throw new DOMException('Prediction 연결이 취소되었습니다.', 'AbortError')
      this.changeState('connected')
      return result.session
    })()
      .catch((error) => {
        this.fail(error)
        throw error
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  private async rpc(session: JobSession, type: string, body: object, requestId: string = crypto.randomUUID()) {
    const sessionId = this.helloValue!.sessionId
    const timeoutMs =
      type === 'artifact.backup' || type === 'artifact.restore'
        ? 1_800_000
        : type.startsWith('artifact.') || type === 'dataset.import' || type === 'dataset.sync'
          ? 600_000
          : 60_000
    const response = await withDeadline(
      timeoutMs,
      type,
      () =>
        session.call(
          type,
          { ...body, protocolVersion: 3, requestId, sessionId },
          {
            timeoutMs,
          },
        ),
      this.lifetime.signal,
    )
    return parseRemoteEnvelope(response.payload, requestId, sessionId)
  }

  private enqueue<T>(
    request: PredictionRequest,
    operation: (session: JobSession) => Promise<T>,
    prediction = false,
    discard?: (value: T) => void,
  ): Promise<T> {
    if (request.signal.aborted || this.disposed)
      return Promise.reject(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
    if (this.pending.has(request.requestId)) return Promise.reject(new Error('Prediction requestId가 중복되었습니다.'))
    if (prediction) {
      if (this.latestQueuedPrediction) this.cancel(this.latestQueuedPrediction)
      this.latestQueuedPrediction = request.requestId
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.queued += 1
    const epoch = this.epoch
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (error?: unknown, value?: T) => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', cancel)
        this.pending.delete(request.requestId)
        if (error) reject(error)
        else resolve(value as T)
      }
      const cancel = () => finish(new DOMException('Prediction 요청이 취소되었습니다.', 'AbortError'))
      this.pending.set(request.requestId, cancel)
      request.signal.addEventListener('abort', cancel, { once: true })
      this.tail = this.tail
        .then(async () => {
          if (this.latestQueuedPrediction === request.requestId) this.latestQueuedPrediction = null
          if (settled) return
          try {
            const session = await this.connect()
            if (settled || epoch !== this.epoch) return cancel()
            const value = await operation(session)
            if (settled) {
              discard?.(value)
              return
            }
            if (epoch !== this.epoch || this.disposed) return cancel()
            finish(undefined, value)
          } catch (error) {
            if (
              (error instanceof RemotePredictionError && invalidSessionCodes.has(error.code)) ||
              (!(error instanceof RemotePredictionError) &&
                !(error instanceof PredictionInstanceInvalidatedError) &&
                (error as { name?: string })?.name !== 'AbortError')
            )
              this.fail(error)
            finish(error)
          }
        })
        .finally(() => {
          request.signal.removeEventListener('abort', cancel)
          this.queued -= 1
          if (this.queued === 0 && !this.disposed && !this.failed) {
            this.idleTimer = setTimeout(() => {
              void this.endIdleSession()
            }, this.options.idleMs ?? 300_000)
          }
        })
    })
  }

  private async endIdleSession() {
    if (this.queued || !this.session) return
    if (this.session.closed) {
      this.failed = true
      this.changeState('failed', '원격 Prediction 연결이 끊어졌습니다. 다시 연결하세요.')
      return
    }
    const session = this.session
    this.session = null
    for (const model of this.models.values()) model.wire = null
    // Serialize a subsequent connect behind graceful finish and resource cleanup.
    this.tail = this.tail.then(async () => {
      try {
        await withDeadline(
          10_000,
          'Prediction 세션 종료',
          () => session.finish({ timeoutMs: 10_000 }),
          this.lifetime.signal,
        )
      } catch {
        await this.cleanupJob(session.jobId)
      } finally {
        session.close()
        if (!this.disposed) this.changeState('idle')
      }
    })
    await this.tail
  }

  inspect(request: PredictionRequest) {
    return this.enqueue(request, async (session) => {
      const hello = remoteHelloSchema.parse(await this.rpc(session, 'predictor.hello', {}, request.requestId))
      if (hello.storageId !== this.helloValue?.storageId || hello.launcherId !== this.launcherId)
        throw new RemotePredictionError('storage-mismatch', '연결된 저장소 identity가 변경되었습니다.')
      this.helloValue = hello
      if (this.options.onHello)
        await withDeadline(
          30_000,
          'Prediction 자산 등록',
          (signal) => this.options.onHello!(hello, signal),
          this.lifetime.signal,
        )
      return hello
    })
  }

  command(type: string, body: object, request: PredictionRequest) {
    return this.enqueue(request, (session) => this.rpc(session, type, body, request.requestId))
  }

  private checkedPrepared(value: unknown, expected?: SavedPredictionModel): RemotePrepared {
    if (
      value &&
      typeof value === 'object' &&
      'artifact' in value &&
      (value.artifact as { direction?: unknown })?.direction !== 'forward'
    )
      throw new RemotePredictionError('model-mismatch', 'Inverse 모델은 지원이 종료되어 실행할 수 없습니다.')
    const wire = remotePreparedSchema.parse(value)
    const artifact = wire.artifact
    const algorithm = this.helloValue?.algorithmDescriptors.find((item) => item.kind === artifact.algorithm)
    if (
      !algorithm?.directions.includes('forward') ||
      (artifact.definition.implementationVersion !== undefined &&
        artifact.definition.implementationVersion !== algorithm.implementationVersion) ||
      (artifact.definition.preprocessingVersion !== undefined &&
        artifact.definition.preprocessingVersion !== algorithm.preprocessingVersion)
    )
      throw new RemotePredictionError(
        'unsupported-execution',
        '이 Predictor가 저장 모델의 알고리즘·버전을 지원하지 않습니다.',
      )
    if (
      wire.instance.sessionId !== this.helloValue?.sessionId ||
      artifact.storageId !== this.helloValue.storageId ||
      artifact.launcherId !== this.launcherId ||
      wire.fingerprint !== artifact.definition.fingerprint ||
      (expected &&
        (artifact.modelId !== expected.modelId ||
          artifact.revision !== expected.modelRevision ||
          wire.fingerprint !== expected.fingerprint ||
          artifact.datasetId !== expected.datasetId ||
          artifact.datasetRevision !== expected.datasetRevision ||
          artifact.direction !== expected.direction ||
          (expected.manifestChecksum !== undefined && artifact.manifestChecksum !== expected.manifestChecksum)))
    )
      throw new RemotePredictionError('model-mismatch', '저장 모델 또는 저장소가 요청한 revision과 다릅니다.')
    return wire
  }

  private ownPrepared(wire: RemotePrepared, route?: PredictionExecutionRoute): RemotePrepared {
    const artifact = wire.artifact
    const reference: SavedPredictionModel = {
      modelId: artifact.modelId,
      modelRevision: artifact.revision,
      datasetId: artifact.datasetId,
      datasetRevision: artifact.datasetRevision,
      direction: artifact.direction,
      fingerprint: wire.fingerprint,
      manifestChecksum: artifact.manifestChecksum,
    }
    const instance = { ...wire.instance, sessionId: this.sessionId, handle: crypto.randomUUID() }
    const prepared = { ...wire, instance, provenance: reference }
    this.models.set(instance.handle, {
      reference,
      route: route ?? { storageId: artifact.storageId, launcherId: artifact.launcherId },
      prepared,
      wire: wire.instance,
    })
    return prepared
  }

  private async recordVerifiedReplica(wire: RemotePrepared) {
    try {
      await withDeadline(
        30_000,
        '모델 복사본 확인',
        (signal) =>
          predictionApi.checkReplica(
            {
              asset_kind: 'model',
              asset_id: wire.artifact.modelId,
              revision: wire.artifact.revision,
              storage_id: wire.artifact.storageId,
              launcher_id: wire.artifact.launcherId,
              state: 'present',
              manifest_sha256: wire.artifact.manifestChecksum,
            },
            { signal },
          ),
        this.lifetime.signal,
      )
    } catch {
      this.options.onWarning?.(
        '모델 파일 검증은 완료했지만 저장 위치 상태를 등록하지 못했습니다. 관리 화면에서 파일 확인을 다시 실행하세요.',
      )
    }
  }

  private lease(
    modelId: string,
    revision: number,
    session: JobSession,
    release = false,
    route?: PredictionExecutionRoute,
  ) {
    return withDeadline(
      30_000,
      '모델 사용권 확인',
      (signal) =>
        predictionApi.lease(
          modelId,
          revision,
          session.jobId,
          release,
          {
            ...(route?.replicaId ? { replica_id: route.replicaId } : {}),
            storage_id: route?.storageId ?? this.helloValue!.storageId,
          },
          { signal },
        ),
      this.lifetime.signal,
    )
  }

  private async releaseRejectedLease(
    modelId: string,
    revision: number,
    session: JobSession,
    error: unknown,
    route?: PredictionExecutionRoute,
  ) {
    if (
      error instanceof RemotePredictionError &&
      !invalidSessionCodes.has(error.code) &&
      ![...this.models.values()].some(
        (other) => other.wire && other.reference.modelId === modelId && other.reference.modelRevision === revision,
      )
    )
      await this.lease(modelId, revision, session, true, route)
  }

  load(reference: SavedPredictionModel, request: PredictionRequest, route?: PredictionExecutionRoute) {
    if (reference.direction !== 'forward')
      return Promise.reject(new RemotePredictionError('unsupported-model', 'Inverse 모델은 지원이 종료되었습니다.'))
    if (!route || route.launcherId !== this.launcherId)
      return Promise.reject(new Error('저장 모델을 사용할 실행 위치를 선택하세요.'))
    return this.enqueue(
      request,
      async (session) => {
        if (route.storageId !== this.helloValue?.storageId)
          throw new RemotePredictionError('storage-mismatch', '선택한 모델 복사본의 저장소가 연결된 저장소와 다릅니다.')
        await this.lease(reference.modelId, reference.modelRevision, session, false, route)
        try {
          const wire = this.checkedPrepared(
            await this.rpc(
              session,
              'model.load',
              {
                modelId: reference.modelId,
                revision: reference.modelRevision,
                manifestChecksum: reference.manifestChecksum,
              },
              request.requestId,
            ),
            reference,
          )
          await this.recordVerifiedReplica(wire)
          return this.ownPrepared(wire, route)
        } catch (error) {
          await this.releaseRejectedLease(reference.modelId, reference.modelRevision, session, error, route)
          throw error
        }
      },
      false,
      (late) => {
        void this.release(late.instance).catch(() => undefined)
      },
    )
  }

  predict(instance: PredictionModelInstance, input: PredictionInput, request: PredictionRequest) {
    return this.enqueue(
      request,
      async (session) => {
        const model = this.models.get(instance.handle)
        if (
          !model ||
          instance.sessionId !== this.sessionId ||
          instance.generation !== model.prepared.instance.generation
        )
          throw new PredictionInstanceInvalidatedError('원격 모델 인스턴스를 다시 로드하세요.', false)
        if (!model.wire) {
          if (model.route.storageId !== this.helloValue?.storageId)
            throw new RemotePredictionError('storage-mismatch', '다시 연결된 저장소가 선택한 복사본과 다릅니다.')
          await this.lease(model.reference.modelId, model.reference.modelRevision, session, false, model.route)
          try {
            const loaded = this.checkedPrepared(
              await this.rpc(session, 'model.load', {
                modelId: model.reference.modelId,
                revision: model.reference.modelRevision,
                manifestChecksum: model.reference.manifestChecksum,
              }),
              model.reference,
            )
            await this.recordVerifiedReplica(loaded)
            if (!this.models.has(instance.handle)) {
              await this.rpc(session, 'model.release', { instance: loaded.instance })
              if (
                ![...this.models.values()].some(
                  (other) =>
                    other.wire &&
                    other.reference.modelId === model.reference.modelId &&
                    other.reference.modelRevision === model.reference.modelRevision,
                )
              )
                await this.lease(model.reference.modelId, model.reference.modelRevision, session, true, model.route)
              throw new PredictionInstanceInvalidatedError('원격 모델 인스턴스가 해제되었습니다.', false)
            }
            model.wire = loaded.instance
          } catch (error) {
            await this.releaseRejectedLease(
              model.reference.modelId,
              model.reference.modelRevision,
              session,
              error,
              model.route,
            )
            throw error
          }
        }
        const result = remoteResultSchema.parse(
          await this.rpc(session, 'model.predict', { instance: model.wire, input }, request.requestId),
        )
        if (
          result.fingerprint !== model.reference.fingerprint ||
          result.direction !== input.direction ||
          result.provenance.modelId !== model.reference.modelId ||
          result.provenance.modelRevision !== model.reference.modelRevision ||
          result.provenance.datasetId !== model.reference.datasetId ||
          result.provenance.datasetRevision !== model.reference.datasetRevision
        )
          throw new RemotePredictionError('model-mismatch', 'Prediction 결과가 요청한 모델과 다릅니다.')
        return result
      },
      true,
    )
  }

  cancel(requestId: string) {
    this.pending.get(requestId)?.()
  }

  async release(instance: PredictionModelInstance) {
    const model = this.models.get(instance.handle)
    if (!model || instance.sessionId !== this.sessionId) return
    this.models.delete(instance.handle)
    if (!model.wire || !this.session || this.session.closed || this.disposed || this.failed) return
    await this.enqueue({ requestId: crypto.randomUUID(), signal: new AbortController().signal }, async (session) => {
      await this.rpc(session, 'model.release', { instance: model.wire })
      if (
        ![...this.models.values()].some(
          (other) =>
            other.reference.modelId === model.reference.modelId &&
            other.reference.modelRevision === model.reference.modelRevision,
        )
      )
        await this.lease(model.reference.modelId, model.reference.modelRevision, session, true, model.route)
    })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort(new DOMException('Prediction 연결이 종료되었습니다.', 'AbortError'))
    this.epoch += 1
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const cancel of this.pending.values()) cancel()
    this.models.clear()
    const session = this.session
    this.session = null
    session?.close()
    if (session) void this.cleanupJob(session.jobId)
    if (this.connectingJobId) void this.cleanupJob(this.connectingJobId)
    this.changeState('disconnected')
  }
}
