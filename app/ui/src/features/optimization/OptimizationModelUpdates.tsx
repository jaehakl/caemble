import { Link } from 'react-router'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Optimization, OptimizationQualityAssessment } from '@/contracts/api/optimization'
import { OptimizationQuality } from './OptimizationQuality'

const updateStates: Record<string, string> = {
  pending: '학습 준비 중',
  preparing: '학습 준비 중',
  queued: '학습 대기',
  running: '학습 중',
  ready: '다음 회차 채택 대기',
  completed: '학습 완료',
  completed_unadopted: '학습 완료 · 미채택',
  adopted: '채택 완료',
  failed: '학습 실패',
  interrupted: '학습 중단',
  cancelled: '학습 취소',
  superseded: '이후 갱신으로 교체됨',
}

function ModelVersion({
  source,
  label,
}: {
  source: {
    model_id: string
    model_revision: number
    version_name?: unknown
    quality_assessment?: OptimizationQualityAssessment
  }
  label: string
}) {
  return (
    <>
      <span>
        {typeof source.version_name === 'string' ? `${source.version_name} · ` : ''}revision {source.model_revision}
      </span>
      <span className="block font-mono break-all text-muted-foreground">{source.model_id}</span>
      <OptimizationQuality assessment={source.quality_assessment} label={label} />
    </>
  )
}

export function OptimizationModelUpdates({
  optimization,
  busy,
  compact,
  onUpdate,
}: {
  optimization: Optimization
  busy: boolean
  compact: boolean
  onUpdate: () => void
}) {
  const update = optimization.model_update
  const initial = update?.initial_model ?? optimization.definition.hybrid
  if (!initial) return null
  const active = update?.active_model ?? initial
  const latest = update?.updates[update.updates.length - 1]
  const waiting =
    update?.waiting ||
    !!update?.pending_model ||
    (!!latest && ['pending', 'preparing', 'queued', 'running'].includes(latest.state))
  const error = typeof latest?.error === 'string' ? latest.error : latest?.error?.message
  return (
    <section aria-label="Hybrid 모델 갱신" className="space-y-3 rounded-lg border p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Hybrid 모델</h4>
        {['running', 'paused'].includes(optimization.state) ? (
          <Button size="sm" variant="outline" disabled={busy || waiting} onClick={onUpdate}>
            <RefreshCw className="size-3.5" />
            모델 갱신
          </Button>
        ) : null}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">초기 모델</dt>
          <dd className="mt-1">
            <ModelVersion source={initial} label="초기 모델 품질" />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">현재 채택 모델</dt>
          <dd className="mt-1">
            <ModelVersion source={active} label="현재 채택 모델 품질" />
          </dd>
        </div>
        {!compact && update?.round_model ? (
          <div>
            <dt className="text-muted-foreground">현재 회차 모델</dt>
            <dd className="mt-1">
              <ModelVersion source={update.round_model} label="현재 회차 모델 품질" />
            </dd>
          </div>
        ) : null}
        {update?.pending_model ? (
          <div>
            <dt className="text-muted-foreground">다음 회차 채택 대기</dt>
            <dd className="mt-1">
              <ModelVersion source={update.pending_model} label="채택 대기 모델 품질" />
            </dd>
          </div>
        ) : null}
      </dl>
      {latest ? (
        <p role="status">
          {latest.version_name} · {updateStates[latest.state] ?? latest.state}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
      {latest?.quality_assessment ? (
        <OptimizationQuality assessment={latest.quality_assessment} label="최근 갱신 모델 품질" />
      ) : null}
      {latest && ['failed', 'interrupted', 'cancelled'].includes(latest.state) ? (
        <p>
          <Link className="underline" to="/settings/prediction">
            Prediction 관리
          </Link>
          에서 학습 작업을 확인하고 재시도하세요. 기존 채택 모델로 탐색을 계속할 수 있습니다.
        </p>
      ) : null}
      {!compact ? (
        <>
          <p className="leading-relaxed text-muted-foreground">
            모델 갱신은 같은 Experiment의 확정된 해석 결과를 고정해 새 revision을 학습합니다. 현재 회차는 기존 모델로
            마치고 다음 회차부터 새 모델을 사용합니다.
          </p>
          {update?.updates.length ? (
            <details>
              <summary className="cursor-pointer">모델 갱신 이력</summary>
              <ul className="mt-2 space-y-2">
                {update.updates.map((item) => (
                  <li key={item.request_id} className="break-all">
                    <p>
                      {item.version_name} · revision {item.revision} · {updateStates[item.state] ?? item.state}
                    </p>
                    <p className="text-muted-foreground">Operation {item.operation_id}</p>
                    {item.adopted_round != null ? <p>{item.adopted_round}회차부터 사용</p> : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
