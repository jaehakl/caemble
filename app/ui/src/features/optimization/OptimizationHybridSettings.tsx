import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { predictionApi } from '@/api/prediction'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import type { OptimizationDraft } from './optimizationDraft'

const qualityOutputSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  data_schema: z.object({ unit: z.string(), boxGrid: z.object({ components: z.array(z.string()) }) }),
})

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
  const quality = revision?.artifact?.quality_report
  const records = revision?.source_contracts.records
  const outputs = (Array.isArray(records) ? records : []).flatMap((record: unknown) => {
    const parsed = qualityOutputSchema.safeParse(record)
    return parsed.success ? [parsed.data] : []
  })
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
            onChange({
              modelId: event.target.value,
              modelRevision: '',
              replicaId: '',
              launcherId: '',
              qualityRequirements: [],
            })
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
          onChange={(event) =>
            onChange({ modelRevision: event.target.value, replicaId: '', launcherId: '', qualityRequirements: [] })
          }
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
      {revision ? (
        <fieldset className="space-y-3 rounded border p-3">
          <legend className="px-1 font-medium">출력별 품질 조건 · 선택 사항</legend>
          <p className="text-xs text-muted-foreground">
            사용 revision {revision.revision}. 필요한 출력의 RMSE 상한을 원래 단위로 입력하세요. 빈 항목은 조건에
            포함하지 않습니다. 시작할 때 서버가 저장 보고서로 판정하며, 조건을 충족하지 못하거나 미평가이면 시작을
            거부합니다.
          </p>
          {outputs.flatMap((record) =>
            record.data_schema.boxGrid.components.map((component) => {
              const requirement = draft.qualityRequirements.find(
                (item) => item.recordId === record.id && item.component === component,
              )
              const reported = quality?.records.find((item) => item.recordId === record.id)
              const metric =
                reported?.status === 'evaluated'
                  ? reported.components.find((item) => item.component === component)
                  : undefined
              return (
                <label key={`${record.id}:${component}`} className="block space-y-1">
                  <span>
                    {record.name} · {component} RMSE 상한 ({record.data_schema.unit})
                  </span>
                  <Input
                    aria-label={`${record.name} · ${component} RMSE 상한 (${record.data_schema.unit})`}
                    type="number"
                    min="0"
                    step="any"
                    value={requirement?.rmseMaximum ?? ''}
                    onChange={(event) =>
                      onChange({
                        qualityRequirements: [
                          ...draft.qualityRequirements.filter(
                            (item) => item.recordId !== record.id || item.component !== component,
                          ),
                          ...(event.target.value === ''
                            ? []
                            : [{ recordId: record.id, component, rmseMaximum: event.target.value }]),
                        ],
                      })
                    }
                  />
                  <span className="block text-xs text-muted-foreground">
                    저장 보고서 RMSE:{' '}
                    {metric ? `${metric.rmse} ${reported?.unit ?? record.data_schema.unit}` : '미평가'}
                  </span>
                </label>
              )
            }),
          )}
          {!outputs.length ? (
            <p className="text-xs text-muted-foreground">품질 조건을 지정할 수 있는 출력 계약이 없습니다.</p>
          ) : null}
          {!draft.qualityRequirements.length ? (
            <p className="text-xs text-muted-foreground">품질 미확인 · 조건 없이 시작할 수 있습니다.</p>
          ) : null}
        </fieldset>
      ) : null}
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
