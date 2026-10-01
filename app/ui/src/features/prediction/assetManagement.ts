import { GpStationClient, type LauncherView } from '@gpstation/v1-master-js-sdk'
import { browserClient } from '@/api/http'
import { predictionApi } from '@/api/prediction'
import type {
  PredictionDatasetRecord,
  PredictionModelRecord,
  PredictionOperation,
  PredictionStorage,
} from '@/contracts/api/prediction'
import type { RuntimeActivityCallback } from '@/features/runtime-console/types'
import { RemotePredictionExecution } from './remoteExecution'
import { reconcileRemoteAssets } from './remoteAssets'

export type PredictionAssetTask = Readonly<{
  id: string
  key: string
  label: string
  state: 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'
  message: string
  operationId?: string
}>
type PredictionAssetList = 'models' | 'datasets' | 'storages' | 'operations' | 'launchers'
export type PredictionAssetsSnapshot = Readonly<{
  models: readonly PredictionModelRecord[]
  datasets: readonly PredictionDatasetRecord[]
  storages: readonly PredictionStorage[]
  launchers: readonly LauncherView[]
  operations: readonly PredictionOperation[]
  tasks: readonly PredictionAssetTask[]
  loading: boolean
  error: string | null
  listErrors: Readonly<Partial<Record<PredictionAssetList, string>>>
  launchersLoaded: boolean
}>
export type PredictionAssetWork = Readonly<{
  id: string
  signal: AbortSignal
  connect: (launcherId: string, preparation?: boolean) => Promise<RemotePredictionExecution>
  progress: (message: string) => void
  operation: (operation: PredictionOperation) => void
}>
type RunningTask = {
  abort: AbortController
  executions: Map<string, RemotePredictionExecution>
  jobIds: Set<string>
  operationId?: string
  operationState?: string
}

/** Owns management jobs independently of a dialog or an inference session. */
export class PredictionAssetController {
  private snapshot: PredictionAssetsSnapshot = {
    models: [],
    datasets: [],
    storages: [],
    launchers: [],
    operations: [],
    tasks: [],
    loading: false,
    error: null,
    listErrors: {},
    launchersLoaded: false,
  }
  private listeners = new Set<() => void>()
  private tasks = new Map<string, RunningTask>()
  private retries = new Map<string, () => Promise<unknown>>()
  private refreshSequence = 0
  private client = new GpStationClient({
    apiBaseUrl: browserClient.baseUrl,
    authMode: 'cookie',
    jobApiPrefix: '/web/jobs',
  })
  active = true
  currentSelectionKey = ''
  onActivity?: RuntimeActivityCallback

  constructor(
    readonly scope: string | null,
    readonly experimentId: number | null,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.snapshot

  private update(change: Partial<PredictionAssetsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    this.listeners.forEach((listener) => listener())
  }

  private updateTask(id: string, change: Partial<PredictionAssetTask>) {
    this.update({ tasks: this.snapshot.tasks.map((task) => (task.id === id ? { ...task, ...change } : task)) })
  }

  async refresh() {
    if (!this.scope || !this.experimentId) return
    const sequence = ++this.refreshSequence
    this.update({ loading: true, error: null, listErrors: {} })
    const [models, datasets, storages, operations, launchers] = await Promise.allSettled([
      predictionApi.models(this.experimentId),
      predictionApi.datasets(this.experimentId),
      predictionApi.storages(),
      predictionApi.operations(this.experimentId),
      this.client.listLaunchers(),
    ])
    if (sequence !== this.refreshSequence) return
    const results = { models, datasets, storages, operations, launchers }
    const labels = {
      models: '모델',
      datasets: '학습 데이터',
      storages: '저장 위치',
      operations: '작업',
      launchers: '장비',
    }
    const listErrors: Partial<Record<PredictionAssetList, string>> = {}
    for (const key of Object.keys(results) as PredictionAssetList[]) {
      const result = results[key]
      if (result.status === 'rejected')
        listErrors[key] =
          `${labels[key]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
    }
    this.update({
      models: models.status === 'fulfilled' ? models.value : this.snapshot.models,
      datasets: datasets.status === 'fulfilled' ? datasets.value : this.snapshot.datasets,
      storages: storages.status === 'fulfilled' ? storages.value : this.snapshot.storages,
      operations: operations.status === 'fulfilled' ? operations.value : this.snapshot.operations,
      tasks:
        operations.status === 'fulfilled'
          ? this.snapshot.tasks.map((task) => {
              if (!['waiting', 'failed'].includes(task.state) || !task.operationId) return task
              const operation = operations.value.find((item) => item.id === task.operationId)
              if (!operation) return task
              if (['completed', 'succeeded'].includes(operation.state))
                return { ...task, state: 'succeeded', message: '완료' }
              if (operation.state === 'cancelled')
                return { ...task, state: 'cancelled', message: '중단됨 · 완료된 파일은 유지됩니다.' }
              return task
            })
          : this.snapshot.tasks,
      launchers:
        launchers.status === 'fulfilled'
          ? launchers.value.filter((launcher) => launcher.slave_app_ids.includes('predictor'))
          : this.snapshot.launchers,
      launchersLoaded: this.snapshot.launchersLoaded || launchers.status === 'fulfilled',
      listErrors,
      error: Object.values(listErrors).join('\n') || null,
      loading: false,
    })
  }

  async run<T>(key: string, label: string, action: (work: PredictionAssetWork) => Promise<T>): Promise<T | undefined> {
    if (!this.scope || this.snapshot.tasks.some((task) => task.key === key && task.state === 'running')) return
    const id = crypto.randomUUID()
    const task: RunningTask = { abort: new AbortController(), executions: new Map(), jobIds: new Set() }
    this.tasks.set(id, task)
    this.update({
      tasks: [{ id, key, label, state: 'running' as const, message: '준비 중' }, ...this.snapshot.tasks].slice(0, 30),
    })
    this.retries.set(id, () => this.run(key, label, action))
    const work: PredictionAssetWork = {
      id,
      signal: task.abort.signal,
      progress: (message) => this.updateTask(id, { message }),
      operation: (operation) => {
        task.operationId = operation.id
        task.operationState = operation.state
        this.updateTask(id, { operationId: operation.id })
        this.update({ operations: [operation, ...this.snapshot.operations.filter((item) => item.id !== operation.id)] })
      },
      connect: async (launcherId, preparation = false) => {
        task.abort.signal.throwIfAborted()
        const existing = task.executions.get(launcherId)
        if (existing) return existing
        this.updateTask(id, { message: '장비 연결·자원 대기 중' })
        const remote = new RemotePredictionExecution(launcherId, {
          transport: {
            connect: (requestId) =>
              this.client.runJob(
                'predictor.hello',
                { protocolVersion: 2, requestId },
                {
                  slaveAppId: 'predictor',
                  targetLauncherId: launcherId,
                  autoFinish: false,
                  timeoutMs: 600_000,
                  resources: preparation
                    ? { gpu_count: 0 }
                    : { cpu_cores: 1, startup_ram_bytes: 256 * 1024 ** 2, gpu_count: 0 },
                  onJobCreated: (job) => {
                    task.jobIds.add(job.id)
                    if (task.abort.signal.aborted) void this.client.cancelJob(job.id).catch(() => undefined)
                  },
                },
              ),
            cancel: (jobId) => this.client.cancelJob(jobId),
          },
          onHello: reconcileRemoteAssets,
        })
        task.executions.set(launcherId, remote)
        await remote.inspect({ requestId: crypto.randomUUID(), signal: task.abort.signal })
        task.abort.signal.throwIfAborted()
        return remote
      },
    }
    try {
      const result = await action(work)
      task.abort.signal.throwIfAborted()
      const waiting = task.operationState && !['completed', 'succeeded'].includes(task.operationState)
      this.updateTask(id, {
        state: waiting ? 'waiting' : 'succeeded',
        message: waiting ? '파일 처리 확인 대기 · 작업을 다시 조회하거나 재시도하세요.' : '완료',
      })
      await this.refresh()
      return result
    } catch (error) {
      const cancelled = task.abort.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
      const message = cancelled
        ? '중단됨 · 완료된 파일은 유지됩니다.'
        : error instanceof Error
          ? error.message
          : String(error)
      if (task.operationId && !cancelled)
        await predictionApi.interruptOperation(task.operationId, message).catch(() => undefined)
      this.updateTask(id, { state: cancelled ? 'cancelled' : 'failed', message })
      if (!cancelled) this.onActivity?.({ source: 'prediction', level: 'error', phase: 'assets', message })
      await this.refresh()
      return undefined
    } finally {
      task.executions.forEach((execution) => execution.dispose())
      this.tasks.delete(id)
    }
  }

  async cancelTask(id: string) {
    const task = this.tasks.get(id)
    if (!task) return
    // Fence registration before terminating this management job. Inference has its own session.
    if (task.operationId) {
      try {
        const operation = await predictionApi.cancelOperation(task.operationId)
        if (['completed', 'succeeded'].includes(operation.state)) {
          task.operationState = operation.state
          this.updateTask(id, { message: '이미 완료된 파일을 유지하고 나머지 단계를 중단합니다.' })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.updateTask(id, { message })
        this.onActivity?.({ source: 'prediction', level: 'error', phase: 'assets', message })
        return
      }
    }
    task.abort.abort()
    task.executions.forEach((execution) => execution.dispose())
    await Promise.allSettled([...task.jobIds].map((jobId) => this.client.cancelJob(jobId)))
  }

  async cancelOperation(id: string) {
    const task = [...this.tasks].find(([, item]) => item.operationId === id)
    if (task) await this.cancelTask(task[0])
    else {
      try {
        await predictionApi.cancelOperation(id)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.update({ error: message })
        this.onActivity?.({ source: 'prediction', level: 'error', phase: 'assets', message })
        return
      }
    }
    await this.refresh()
  }

  retryTask(id: string) {
    return this.retries.get(id)?.()
  }

  async disconnectOwner() {
    this.active = false
    for (const task of this.tasks.values()) {
      task.abort.abort()
      task.executions.forEach((execution) => execution.dispose())
      await Promise.allSettled([...task.jobIds].map((jobId) => this.client.cancelJob(jobId)))
    }
  }
}

export function predictionReplicaStatus(
  replica: { state: string } | undefined,
  storage: PredictionStorage | undefined,
) {
  if (!replica) return '파일 확인 필요'
  if (replica.state === 'deleted') return '이 위치에서 제거됨'
  if (replica.state === 'deleting') return '파일 삭제 확인 대기'
  if (replica.state === 'missing') return '파일 없음 · 다른 복사본을 선택하거나 복원하세요'
  if (replica.state === 'corrupt') return '파일 손상 · 이 위치에서 제거한 뒤 백업에서 복원하세요'
  if (storage?.kind === 'object_backup')
    return replica.state === 'present' ? '백업 파일 검증 완료 · 실행하려면 복원하세요' : '백업 파일 확인 필요'
  if (!storage?.accesses.some((access) => access.connected))
    return replica.state === 'present' ? '장비 오프라인 · 마지막 확인 시 파일 존재' : '장비 오프라인 · 파일 확인 필요'
  return replica.state === 'present' ? '예측에 사용 가능' : '파일 확인 필요 · 사용 시 확인합니다'
}
