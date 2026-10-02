import { useQuery } from '@tanstack/react-query'
import { predictionApi } from '@/api/prediction'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import type { OptimizationDraft } from './optimizationDraft'

export function OptimizationHybridSettings({
  experimentId,
  draft,
  onChange,
}: {
  experimentId: number
  draft: OptimizationDraft
  onChange: (change: Partial<OptimizationDraft>) => void
}) {
  const { queryScope } = useAuth()
  const assets = useQuery({
    queryKey: ['optimization-hybrid-assets', queryScope, experimentId],
    queryFn: async ({ signal }) => {
      const [models, storages, algorithms] = await Promise.all([
        predictionApi.models(experimentId, { signal }),
        predictionApi.storages({ signal }),
        predictionApi.algorithms({ signal }),
      ])
      return { models, storages, algorithms }
    },
    refetchInterval: 15_000,
  })
  const models = (assets.data?.models ?? []).flatMap((model) => {
    if (model.state !== 'active' || model.direction !== 'forward') return []
    const revisions = model.revisions.filter((revision) => {
      const algorithm = revision.definition.algorithm as { kind?: unknown } | undefined
      return (
        revision.state === 'ready' &&
        revision.artifact &&
        revision.support_status !== 'unsupported' &&
        revision.support_status !== 'retired' &&
        assets.data?.algorithms.some((item) => item.kind === algorithm?.kind && item.directions.includes('forward'))
      )
    })
    return revisions.length ? [{ ...model, revisions }] : []
  })
  const model = models.find((item) => item.id === draft.modelId)
  const revisions = model?.revisions ?? []
  const revision = revisions.find((item) => String(item.revision) === draft.modelRevision)
  const routes = (revision?.replicas ?? []).flatMap((replica) => {
    const storage = assets.data?.storages.find((item) => item.storage_id === replica.storage_id)
    if (replica.state !== 'present' || storage?.kind !== 'predictor_local') return []
    return storage.accesses.map((access) => ({
      replicaId: replica.id,
      launcherId: access.launcher_id,
      label: `${storage.name} · ${access.launcher_id} · ${access.connected ? '연결됨' : '오프라인'}`,
    }))
  })
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span>저장된 Forward 모델</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={draft.modelId}
          required
          disabled={assets.isPending || assets.isError}
          onChange={(event) =>
            onChange({ modelId: event.target.value, modelRevision: '', replicaId: '', launcherId: '' })
          }
        >
          <option value="">{assets.isPending ? '모델 불러오는 중…' : '모델 선택'}</option>
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span>모델 revision</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={draft.modelRevision}
          required
          disabled={!model}
          onChange={(event) => onChange({ modelRevision: event.target.value, replicaId: '', launcherId: '' })}
        >
          <option value="">revision 선택</option>
          {revisions.map((item) => (
            <option key={item.revision} value={item.revision}>
              {item.version_name ? `${item.version_name} · ` : ''}revision {item.revision} · Dataset revision{' '}
              {item.dataset_revision}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span>모델 복제본 · 실행 Launcher</span>
        <select
          className="h-9 w-full rounded-md border bg-background px-2"
          value={draft.replicaId && draft.launcherId ? `${draft.replicaId}:${draft.launcherId}` : ''}
          required
          disabled={!revision}
          onChange={(event) => {
            const route = routes.find((item) => `${item.replicaId}:${item.launcherId}` === event.target.value)
            onChange({ replicaId: route?.replicaId ?? '', launcherId: route?.launcherId ?? '' })
          }}
        >
          <option value="">실행 위치 선택</option>
          {routes.map((route) => (
            <option key={`${route.replicaId}:${route.launcherId}`} value={`${route.replicaId}:${route.launcherId}`}>
              {route.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span>Solver 실행 시도 예산</span>
        <Input
          type="number"
          min="1"
          max="10000"
          required
          value={Number.isFinite(draft.maxSolverRuns) ? draft.maxSolverRuns : ''}
          onChange={(event) => onChange({ maxSolverRuns: event.target.valueAsNumber })}
        />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">
        선택한 revision으로 시작하고 예측한 후보를 실제 Solver로 검증합니다. 모델 갱신은 시작 후 직접 요청합니다. 실패
        후 Solver 재실행도 예산을 사용합니다. 예측·빌드·후처리 재시도에는 Solver 예산이 들지 않습니다. 실행 Launcher에는
        Evaluation과 선택한 알고리즘의 추론에 필요한 CPU·RAM·GPU 자원이 함께 필요합니다.
      </p>
      {!assets.isPending && !models.length ? (
        <p className="text-xs text-muted-foreground">
          이 Experiment에서 지원되는 Forward 모델을 Prediction에서 먼저 준비하세요.
        </p>
      ) : null}
      {revision && !routes.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          사용 가능한 로컬 모델 복제본이 없습니다. Prediction에서 파일을 확인하거나 복원하세요.
        </p>
      ) : null}
      {assets.isError ? (
        <p role="alert" className="text-destructive">
          모델과 실행 위치를 불러오지 못했습니다.
        </p>
      ) : null}
    </div>
  )
}
