import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { optimizationApi } from '@/api/optimization'
import { Button } from '@/components/ui/button'
import type { OptimizationStudy, OptimizationTrial } from '@/contracts/api/optimization'
import { useAuth } from '@/features/auth/use-auth'
import { describeResourceWait, formatMemory } from '@/features/runtime/resources'
import { optimizationQueryKeys } from './queryKeys'

const stateLabels: Record<string, string> = {
  running: '진행 중',
  pausing: '중지 중',
  paused: '중지됨',
  completed: '완료',
  failed: '실패',
  pending: '대기',
  queued: '대기',
  succeeded: '성공',
  cancelled: '취소됨',
  building: '빌드 중',
  solving: '해석 중',
  calculating: '후처리 중',
}
const stageLabels: Record<string, string> = { build: '빌드', solve: '해석', calculate: '후처리', complete: '완료' }

export function StudyManagement({
  experimentId,
  selectedId,
  onSelect,
  onApplyBest,
  compact = false,
}: {
  experimentId?: number
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  onApplyBest?: (study: OptimizationStudy) => void
  compact?: boolean
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const [localSelected, setLocalSelected] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [trialOffset, setTrialOffset] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retryRequests = useRef(new Map<string, string>())
  const list = useQuery({
    queryKey: optimizationQueryKeys.list(auth.queryScope, experimentId, offset),
    queryFn: ({ signal }) => optimizationApi.list({ experimentId, offset }, { signal }),
    enabled: auth.isAuthenticated,
    refetchInterval: 5_000,
  })
  const id = (onSelect ? selectedId : localSelected) ?? list.data?.items[0]?.id ?? null
  const detail = useQuery({
    queryKey: optimizationQueryKeys.detail(auth.queryScope, id),
    queryFn: ({ signal }) => optimizationApi.read(id!, { signal }),
    enabled: auth.isAuthenticated && id !== null,
    refetchInterval: (query) => {
      const current = query.state.data
      return current &&
        (['running', 'pausing'].includes(current.state) ||
          current.executions_active > 0 ||
          current.cleanup_pending ||
          current.manual_retry_pending)
        ? 3_000
        : false
    },
  })
  const trials = useQuery({
    queryKey: optimizationQueryKeys.trials(auth.queryScope, id, trialOffset),
    queryFn: ({ signal }) => optimizationApi.trials(id!, trialOffset, { signal }),
    enabled: auth.isAuthenticated && id !== null,
    refetchInterval:
      detail.data &&
      (['running', 'pausing'].includes(detail.data.state) ||
        detail.data.executions_active > 0 ||
        detail.data.cleanup_pending ||
        detail.data.manual_retry_pending)
        ? 3_000
        : false,
  })
  const study = detail.data
  const executionBusy = !!study && (study.executions_active > 0 || study.cleanup_pending || study.manual_retry_pending)
  const select = (next: string | null) => {
    setLocalSelected(next)
    onSelect?.(next)
    setTrialOffset(0)
    setError(null)
  }
  async function action(run: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await run()
      await queryClient.invalidateQueries({ queryKey: optimizationQueryKeys.all(auth.queryScope) })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Optimization Studies" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Studies</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={list.isFetching}
          onClick={() => void queryClient.invalidateQueries({ queryKey: optimizationQueryKeys.all(auth.queryScope) })}
        >
          새로고침
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        브라우저를 닫아도 서버와 실행 가능한 Launcher가 있으면 계속 진행합니다.
      </p>
      {error || list.isError || detail.isError || trials.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? (list.error ?? detail.error ?? trials.error)?.message}
        </p>
      ) : null}
      {!list.data?.items.length && !list.isPending ? (
        <p className="text-sm text-muted-foreground">저장된 Study가 없습니다.</p>
      ) : null}
      <div className={compact ? 'space-y-3' : 'grid gap-4 2xl:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]'}>
        <div className="space-y-2">
          <ul aria-label="Study 목록" className="max-h-72 space-y-2 overflow-auto">
            {list.data?.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={id === item.id}
                  className={`w-full rounded border p-2 text-left text-sm ${id === item.id ? 'border-primary bg-muted' : ''}`}
                  onClick={() => select(item.id)}
                >
                  <p className="font-medium">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Experiment #{item.experiment_id} · {stateLabels[item.state] ?? item.state}
                  </p>
                  <p className="mt-1 text-xs">
                    Trial {item.trial_count} / {item.max_trials} · 성공 {item.succeeded} · 실패 {item.failed}
                  </p>
                  <p className="mt-1 text-xs">수동 재시도 {item.retry_count}회</p>
                  {item.best_trial ? (
                    <p className="mt-1 font-mono text-xs">최선 {item.best_trial.result.objective.toPrecision(7)}</p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between text-xs">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => {
                setOffset((value) => Math.max(0, value - 20))
                select(null)
              }}
            >
              이전
            </Button>
            <span>{list.data?.total ?? 0}개 Study</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + 20 >= (list.data?.total ?? 0)}
              onClick={() => {
                setOffset((value) => value + 20)
                select(null)
              }}
            >
              다음
            </Button>
          </div>
        </div>
        {study && study.id === id ? (
          <div className="min-w-0 space-y-3">
            <div>
              <h3 className="font-medium">{study.name}</h3>
              <p className="text-xs text-muted-foreground">
                {stateLabels[study.state] ?? study.state} · 실행 중 {study.executions_active} ·{' '}
                {new Date(study.created_at).toLocaleString()}
              </p>
              {study.pause_reason ? <p className="mt-1 text-xs">{study.pause_reason}</p> : null}
              {study.cleanup_pending ? (
                <p className="mt-1 text-xs">이전 프로세스의 자원 정리를 기다리는 중입니다.</p>
              ) : null}
              {study.manual_retry_pending ? <p className="mt-1 text-xs">실패 단계 재시도를 진행 중입니다.</p> : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {study.state === 'running' ||
              (study.state === 'paused' && (study.executions_active > 0 || study.manual_retry_pending)) ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => void action(() => optimizationApi.stop(study.id))}
                >
                  중지
                </Button>
              ) : null}
              {study.state === 'paused' ? (
                <Button
                  size="sm"
                  disabled={busy || executionBusy || study.failed > 0}
                  title={study.failed > 0 ? '실패한 Trial을 재시도한 뒤 재개하세요.' : undefined}
                  onClick={() => void action(() => optimizationApi.resume(study.id))}
                >
                  재개
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || executionBusy || ['running', 'pausing'].includes(study.state)}
                onClick={() => {
                  if (window.confirm('Study와 Trial 이력을 삭제할까요? 저장된 Measurement는 유지됩니다.'))
                    void action(async () => {
                      await optimizationApi.remove(study.id)
                      select(null)
                    })
                }}
              >
                삭제
              </Button>
              {!onApplyBest ? (
                <Button size="sm" variant="outline" asChild>
                  <Link to={`/?experiment=${study.experiment_id}&study=${encodeURIComponent(study.id)}`}>
                    최적화에서 열기
                  </Link>
                </Button>
              ) : null}
            </div>
            {study.best_trial ? (
              <div className="space-y-2 rounded border bg-muted/30 p-3 text-sm">
                <p className="font-medium">최선 후보 · Trial {study.best_trial.ordinal}</p>
                <p className="font-mono">
                  {study.best_trial.result.objective.toPrecision(8)} ·{' '}
                  {study.settings.objective.direction === 'minimize' ? '최소화' : '최대화'}
                </p>
                <details>
                  <summary className="cursor-pointer text-xs">Vars 확인</summary>
                  <pre className="mt-1 max-h-40 overflow-auto text-xs">
                    {JSON.stringify(study.best_trial.variables, null, 2)}
                  </pre>
                </details>
                {onApplyBest ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => onApplyBest(study)}>
                    최선 Vars로 새 Candidate 열기
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">제약조건을 만족한 최선 후보가 아직 없습니다.</p>
            )}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">고정된 평가 정의</summary>
              <dl className="mt-1 space-y-1 text-xs break-all">
                <dt>Experiment source</dt>
                <dd className="font-mono">{study.definition.source_hash}</dd>
                <dt>Catalog</dt>
                <dd className="font-mono">{study.definition.catalog_revision}</dd>
                <dt>Calculation</dt>
                {study.definition.calculations.map((calculation) => (
                  <dd key={calculation.key}>
                    #{calculation.calculation_id} · revision {calculation.source_revision}
                  </dd>
                ))}
              </dl>
            </details>
            <ul aria-label="Trial 이력" className="space-y-2">
              {trials.data?.items.map((trial) => (
                <TrialHistory
                  key={trial.id}
                  trial={trial}
                  disabled={busy || executionBusy || study.state !== 'paused'}
                  onRetry={() => {
                    const key = `${trial.id}:${trial.retry_count}`
                    const requestId = retryRequests.current.get(key) ?? crypto.randomUUID()
                    retryRequests.current.set(key, requestId)
                    void action(() => optimizationApi.retry(study.id, trial.id, requestId))
                  }}
                />
              ))}
            </ul>
            <div className="flex items-center justify-between text-xs">
              <Button
                size="sm"
                variant="ghost"
                disabled={trialOffset === 0}
                onClick={() => setTrialOffset((value) => Math.max(0, value - 20))}
              >
                이전 Trial
              </Button>
              <span>{trials.data?.total ?? 0}개 Trial</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={trialOffset + 20 >= (trials.data?.total ?? 0)}
                onClick={() => setTrialOffset((value) => value + 20)}
              >
                다음 Trial
              </Button>
            </div>
          </div>
        ) : id && detail.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Study를 불러오는 중…
          </p>
        ) : null}
      </div>
    </section>
  )
}

function TrialHistory({
  trial,
  disabled,
  onRetry,
}: {
  trial: OptimizationTrial
  disabled: boolean
  onRetry: () => void
}) {
  return (
    <li className="rounded border p-2 text-xs">
      <details>
        <summary className="cursor-pointer">
          <span className="font-medium">Trial {trial.ordinal}</span> · {stateLabels[trial.state] ?? trial.state} ·{' '}
          {stageLabels[trial.next_stage]}
          {trial.result
            ? ` · ${trial.result.objective.toPrecision(7)} · ${trial.result.feasible ? '제약 충족' : '제약 위반'}`
            : ''}
        </summary>
        <p className="mt-2">수동 재시도 {trial.retry_count}회 · 새 Trial 예산을 사용하지 않습니다.</p>
        {trial.error ? <p className="mt-2 break-words text-destructive">{trial.error.message}</p> : null}
        {trial.measurement_id ? <p className="mt-2">Measurement #{trial.measurement_id}</p> : null}
        {trial.result?.constraints.map((constraint) => (
          <p className="mt-1" key={constraint.key}>
            {constraint.key}: {constraint.value.toPrecision(6)} · {constraint.satisfied ? '충족' : '위반'}
          </p>
        ))}
        {['build', 'solve', 'calculate'].map((stage) => {
          const history = trial.stages.filter((item) => item.stage === stage)
          return history.length ? (
            <div className="mt-2 space-y-1 border-l pl-2" key={stage}>
              <p className="font-medium">{stageLabels[stage]}</p>
              {history.map((attempt) => (
                <div className="rounded bg-muted/30 p-2" key={attempt.id}>
                  <p>
                    제출 {attempt.generation} · {stateLabels[attempt.state] ?? attempt.state}
                    {attempt.job ? ` · attempt ${attempt.job.attempt_count}` : ''}
                  </p>
                  <p className="mt-1 font-mono break-all text-muted-foreground">Job {attempt.job_id ?? '대기'}</p>
                  {attempt.job?.waiting_reason ? <p>{describeResourceWait(attempt.job.waiting_reason)}</p> : null}
                  {attempt.job?.allocation ? (
                    <p>
                      CPU {attempt.job.allocation.cpu_cores} · GPU {attempt.job.allocation.gpu_devices.length} · RAM{' '}
                      {formatMemory(attempt.job.ram_used_bytes)}
                    </p>
                  ) : null}
                  {attempt.job?.cleanup_pending ? <p>프로세스 정리 중 · 자원 반환 대기</p> : null}
                  {attempt.error || attempt.job?.last_error ? (
                    <p className="break-words text-destructive">{attempt.error?.message ?? attempt.job?.last_error}</p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null
        })}
        <details className="mt-2">
          <summary className="cursor-pointer">Vars</summary>
          <pre className="max-h-40 overflow-auto">{JSON.stringify(trial.variables, null, 2)}</pre>
        </details>
        {trial.state === 'failed' ? (
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            disabled={disabled || trial.manual_retry_requested}
            onClick={onRetry}
          >
            {trial.manual_retry_requested ? '재시도 접수됨' : '실패 단계 재시도'}
          </Button>
        ) : null}
      </details>
    </li>
  )
}
