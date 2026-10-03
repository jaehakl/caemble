import {
  Activity,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Trophy,
} from 'lucide-react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Optimization, OptimizationEvaluation, OptimizationTrial } from '@/contracts/api/optimization'
import { useAuth } from '@/features/auth/use-auth'
import { describeResourceWait, formatMemory } from '@/features/runtime/resources'
import { useOptimizationData } from './useOptimizationData'
import { OptimizationModelUpdates } from './OptimizationModelUpdates'

const stateLabels: Record<string, string> = {
  running: '진행 중',
  pausing: '중지 중',
  paused: '중지됨',
  completed: '완료',
  failed: '실패',
  pending: '대기',
  predicted: '예측 완료',
  queued: '대기',
  succeeded: '성공',
  cancelled: '취소됨',
  building: '빌드 중',
  solving: '해석 중',
  calculating: '후처리 중',
  predicting: '예측 중',
}
const stageLabels: Record<string, string> = {
  predict: '예측',
  build: '빌드',
  solve: '해석',
  calculate: '후처리',
  complete: '완료',
}
const terminationLabels: Record<string, string> = {
  solver_budget_exhausted: 'Solver 실행 시도 예산 소진',
  candidate_limit: '최대 후보 수 도달',
  search_converged: '탐색 완료',
}

function OptimizationStatus({ state }: { state: string }) {
  const active = ['running', 'pausing', 'building', 'solving', 'calculating', 'predicting'].includes(state)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        active
          ? 'border-primary/20 bg-primary/5 text-primary'
          : ['failed', 'paused'].includes(state)
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-700'
            : ['completed', 'succeeded'].includes(state)
              ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700'
              : 'bg-muted/50 text-muted-foreground',
      )}
    >
      {active ? (
        <LoaderCircle className="size-3 animate-spin" />
      ) : (
        <span className="size-1.5 rounded-full bg-current" />
      )}
      {stateLabels[state] ?? state}
    </span>
  )
}

type OptimizationManagementProps = {
  experimentId?: number
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  onApplyBest?: (optimization: Optimization) => void
  compact?: boolean
}

export function OptimizationManagement(props: OptimizationManagementProps) {
  const { queryScope } = useAuth()
  return <ScopedOptimizationManagement key={`${queryScope}:${props.experimentId ?? 'all'}`} {...props} />
}

function ScopedOptimizationManagement(props: OptimizationManagementProps) {
  const data = useOptimizationData({ ...props, includeTrials: !props.compact })
  return <OptimizationManagementView data={data} onApplyBest={props.onApplyBest} compact={props.compact} />
}

export function OptimizationManagementView({
  data,
  onApplyBest,
  compact = false,
}: {
  data: ReturnType<typeof useOptimizationData>
  onApplyBest?: (optimization: Optimization) => void
  compact?: boolean
}) {
  const { id, optimization, executionBusy, list, detail, trials, offset, trialOffset, busy, error, select } = data
  const bestVerified =
    optimization?.best_verified_trial === undefined ? optimization?.best_trial : optimization.best_verified_trial
  const bestPredicted = optimization?.best_predicted_trial
  const hybrid = !!optimization?.settings.hybrid
  const algorithm = optimization?.settings.algorithm ?? {
    id: 'coordinate',
    version: 1,
    config: {
      initial_step: optimization?.settings.initial_step ?? 0.25,
      min_step: optimization?.settings.min_step ?? 0.001,
    },
  }
  return (
    <section aria-label="Optimizations" className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Activity className="size-4 text-muted-foreground" />
            Optimizations
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">실행 현황과 최선 후보</p>
        </div>
        <Button size="sm" variant="outline" disabled={list.isFetching} onClick={() => void data.refresh()}>
          <RefreshCw className={cn('size-3.5', list.isFetching && 'animate-spin')} />
          새로고침
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        브라우저를 닫아도 서버와 실행 가능한 Launcher가 있으면 계속 진행합니다.
      </p>
      {data.unavailableId ? (
        <div role="status" className="space-y-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <p className="text-muted-foreground">
            요청한 Optimization을 찾을 수 없거나 현재 Experiment에서 열 수 없습니다.
          </p>
          <Button size="sm" variant="outline" onClick={data.recover}>
            목록으로 돌아가기
          </Button>
        </div>
      ) : null}
      {error || list.isError || (!data.unavailableId && detail.isError) || (!compact && trials.isError) ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error ?? (list.error ?? detail.error ?? trials.error)?.message}
        </p>
      ) : null}
      {list.isPending ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border bg-background p-6 text-sm text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" />
          Optimization 목록을 불러오는 중…
        </p>
      ) : null}
      {!list.data?.items.length && !list.isPending && !list.isError ? (
        <div className="rounded-xl border border-dashed bg-background px-6 py-12 text-center">
          <FlaskConical className="mx-auto mb-4 size-8 text-muted-foreground/60" />
          <p className="text-sm font-medium">저장된 Optimization이 없습니다.</p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            새 Optimization에서 목적함수와 탐색 범위를 설정하세요.
            <br />
            평가가 시작되면 진행 상태와 최선 후보를 여기에서 확인할 수 있습니다.
          </p>
        </div>
      ) : null}
      <div className={compact ? 'space-y-4' : 'grid min-h-0 gap-5 lg:grid-cols-[minmax(14rem,19rem)_minmax(0,1fr)]'}>
        <div className="min-w-0 space-y-2">
          <ul aria-label="Optimization 목록" className="max-h-[28rem] space-y-2 overflow-y-auto p-0.5">
            {list.data?.items.map((item) => (
              <li key={item.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={id === item.id}
                  className={cn(
                    'h-full w-full rounded-lg border bg-background p-3 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring',
                    id === item.id && 'border-primary/50 bg-primary/5 ring-1 ring-primary/15',
                  )}
                  onClick={() => select(item.id)}
                >
                  <p className="truncate font-medium" title={item.name}>
                    {item.name}
                  </p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <OptimizationStatus state={item.state} />
                    <span className="text-xs text-muted-foreground">#{item.experiment_id}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Trial {item.trial_count} / {item.max_trials} · 성공 {item.succeeded} · 실패 {item.failed}
                  </p>
                  {item.best_trial ? (
                    <p className="mt-1 font-mono text-xs">최선 {item.best_trial.result.objective.toPrecision(7)}</p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {offset > 0 || (list.data?.total ?? 0) > 20 ? (
            <div className="flex items-center justify-between text-xs">
              <Button
                size="sm"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => {
                  data.page(offset - 20)
                }}
              >
                이전
              </Button>
              <span>{list.data?.total ?? 0}개 Optimization</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={offset + 20 >= (list.data?.total ?? 0)}
                onClick={() => {
                  data.page(offset + 20)
                }}
              >
                다음
              </Button>
            </div>
          ) : null}
        </div>
        {optimization && optimization.id === id ? (
          <div className="min-w-0 space-y-4 rounded-xl border bg-background p-4 sm:p-5">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 font-semibold break-words">{optimization.name}</h3>
                <OptimizationStatus state={optimization.state} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Experiment #{optimization.experiment_id} · {new Date(optimization.created_at).toLocaleString()}
              </p>
              {optimization.pause_reason ? (
                <p className="mt-3 rounded-md bg-muted p-3 text-xs leading-relaxed">{optimization.pause_reason}</p>
              ) : null}
              {!optimization.continuation.supported ? (
                <p role="status" className="mt-3 rounded-md bg-muted p-3 text-xs leading-relaxed">
                  {optimization.continuation.reason}
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground" aria-label="저장된 탐색 설정">
                {algorithm.id === 'random'
                  ? `무작위 탐색 · seed ${algorithm.config.seed} · 회차당 ${algorithm.config.candidates_per_round}개`
                  : `좌표 탐색 · 초기 step ${algorithm.config.initial_step} · 최소 step ${algorithm.config.min_step}`}
              </p>
              {optimization.termination_reason ? (
                <p className="mt-2 text-xs">
                  종료 사유: {terminationLabels[optimization.termination_reason] ?? optimization.termination_reason}
                </p>
              ) : null}
              {optimization.cleanup_pending ? (
                <p className="mt-1 text-xs">이전 프로세스의 자원 정리를 기다리는 중입니다.</p>
              ) : null}
              {optimization.manual_retry_pending ? (
                <p className="mt-1 text-xs">실패 단계 재시도를 진행 중입니다.</p>
              ) : null}
            </div>
            {optimization.solver_budget ? (
              <div className="rounded-lg border p-3 text-xs" aria-label="Solver 실행 예산">
                <p className="font-medium">Solver 실행 시도 {optimization.solver_budget.limit}회</p>
                <p className="mt-1">
                  사용 {optimization.solver_budget.used} · 예약 {optimization.solver_budget.reserved} · 잔여{' '}
                  {optimization.solver_budget.remaining}
                </p>
                <p className="mt-1 text-muted-foreground">
                  실행 전 취소는 예약을 반환합니다. 실행 승인 후 실패와 Solver 재실행은 예산을 사용합니다.
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {optimization.state === 'running' ||
              (optimization.state === 'paused' &&
                (optimization.executions_active > 0 || optimization.manual_retry_pending)) ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void data.stop(optimization.id)}>
                  <Pause className="size-3.5" />
                  중지
                </Button>
              ) : null}
              {optimization.state === 'paused' ? (
                <Button
                  size="sm"
                  disabled={busy || executionBusy || optimization.failed > 0 || !optimization.continuation.supported}
                  title={
                    optimization.continuation.reason ??
                    (optimization.failed > 0 ? '실패한 Trial을 재시도한 뒤 재개하세요.' : undefined)
                  }
                  onClick={() => void data.resume(optimization.id)}
                >
                  <Play className="size-3.5" />
                  재개
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || executionBusy || ['running', 'pausing'].includes(optimization.state)}
                onClick={() => {
                  if (window.confirm('Optimization과 Trial 이력을 삭제할까요? 저장된 Measurement는 유지됩니다.'))
                    void data.remove(optimization.id)
                }}
              >
                삭제
              </Button>
              {compact || !onApplyBest ? (
                <Button size="sm" variant="outline" asChild>
                  <Link
                    to={`/?experiment=${optimization.experiment_id}&optimization=${encodeURIComponent(optimization.id)}`}
                  >
                    Workbench에서 열기
                  </Link>
                </Button>
              ) : null}
            </div>
            {busy ? (
              <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" />
                요청을 처리하고 있습니다…
              </p>
            ) : null}
            {hybrid ? (
              <OptimizationModelUpdates
                optimization={optimization}
                busy={busy}
                compact={compact}
                onUpdate={() => void data.modelUpdate(optimization.id)}
              />
            ) : null}
            <div className="space-y-3 rounded-lg bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">평가 예산</span>
                <span className="text-muted-foreground tabular-nums">
                  생성 {optimization.trial_count} / 최대 {optimization.max_trials}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="평가 예산 사용"
                aria-valuemin={0}
                aria-valuemax={optimization.max_trials}
                aria-valuenow={optimization.trial_count}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width: `${Math.min(100, (optimization.trial_count / Math.max(1, optimization.max_trials)) * 100)}%`,
                  }}
                />
              </div>
              <dl className="grid grid-cols-4 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">성공</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{optimization.succeeded}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">실행 중</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">{optimization.executions_active}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">실패</dt>
                  <dd
                    className={cn(
                      'mt-1 text-lg font-semibold tabular-nums',
                      optimization.failed > 0 && 'text-destructive',
                    )}
                  >
                    {optimization.failed}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">수동 재시도</dt>
                  <dd className="mt-1 text-lg font-semibold tabular-nums">
                    {optimization.retry_count}
                    <span className="ml-1 text-xs font-normal">회</span>
                  </dd>
                </div>
              </dl>
            </div>
            {optimization.state === 'paused' && optimization.failed > 0 ? (
              <p className="rounded-md border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-700">
                {compact
                  ? 'Workbench에서 실패한 Trial의 오류를 확인하고 재시도하세요.'
                  : '실패한 Trial을 펼쳐 오류를 확인하고 실패 단계를 재시도하세요. 실패가 해결되면 탐색을 재개할 수 있습니다.'}
              </p>
            ) : null}
            {hybrid ? (
              <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm" aria-label="예측 최선 후보">
                <p className="font-medium">예측 최선 후보{bestPredicted ? ` · Trial ${bestPredicted.ordinal}` : ''}</p>
                {bestPredicted ? (
                  <>
                    <p className="font-mono text-xl font-semibold">
                      {Number(bestPredicted.result.objective.toPrecision(8))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Forward 예측 · 제약 충족 · 실제 해석 검증과 별도 결과
                    </p>
                    {bestPredicted.source ? (
                      <p className="text-xs text-muted-foreground">
                        예측 모델 revision {String(bestPredicted.source.model_revision ?? '')}
                        {typeof bestPredicted.source.version_name === 'string'
                          ? ` · ${bestPredicted.source.version_name}`
                          : ''}
                      </p>
                    ) : null}
                    {!compact ? (
                      <details>
                        <summary className="cursor-pointer text-xs">예측 Vars 확인</summary>
                        <pre className="mt-1 max-h-40 overflow-auto text-xs">
                          {JSON.stringify(bestPredicted.variables, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">제약조건을 만족한 예측 결과가 아직 없습니다.</p>
                )}
              </div>
            ) : null}
            {bestVerified ? (
              <div className="space-y-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4 text-sm">
                <p className="flex items-center gap-2 font-medium">
                  <Trophy className="size-4 text-emerald-600" />
                  {hybrid ? '검증된 최선 후보' : '최선 후보'} · Trial {bestVerified.ordinal}
                </p>
                <div className="flex flex-wrap items-baseline gap-2">
                  <p className="font-mono text-2xl font-semibold tracking-tight break-all">
                    {Number(bestVerified.result.objective.toPrecision(8))}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {optimization.settings.objective.direction === 'minimize' ? '최소화' : '최대화'} · 제약 충족
                  </span>
                </div>
                {!compact ? (
                  <details>
                    <summary className="cursor-pointer text-xs">Vars 확인</summary>
                    <pre className="mt-1 max-h-40 overflow-auto text-xs">
                      {JSON.stringify(bestVerified.variables, null, 2)}
                    </pre>
                  </details>
                ) : null}
                {!compact && onApplyBest ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onApplyBest({ ...optimization, best_trial: bestVerified })}
                  >
                    최선 Vars로 새 Candidate 열기
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-xs leading-relaxed text-muted-foreground">
                제약조건을 만족한 검증 결과가 아직 없습니다. 실제 해석 평가가 성공하면 목적값과 Vars가 표시됩니다.
              </p>
            )}
            {!compact ? (
              <>
                <details>
                  <summary className="cursor-pointer text-xs text-muted-foreground">고정된 평가 정의</summary>
                  <dl className="mt-1 space-y-1 text-xs break-all">
                    <dt>Experiment source</dt>
                    <dd className="font-mono">{optimization.definition.source_hash}</dd>
                    <dt>Catalog</dt>
                    <dd className="font-mono">{optimization.definition.catalog_revision}</dd>
                    <dt>Calculation</dt>
                    {optimization.definition.calculations.map((calculation) => (
                      <dd key={calculation.key}>
                        #{calculation.calculation_id} · revision {calculation.source_revision}
                      </dd>
                    ))}
                    {optimization.definition.hybrid ? (
                      <>
                        <dt>초기 모델</dt>
                        <dd>
                          {optimization.definition.hybrid.model_id} · revision{' '}
                          {optimization.definition.hybrid.model_revision}
                        </dd>
                        <dt>모델 checksum</dt>
                        <dd className="font-mono">{String(optimization.definition.hybrid.checksum ?? '')}</dd>
                        <dt>Dataset</dt>
                        <dd>
                          {String(optimization.definition.hybrid.dataset_id ?? '')} · revision{' '}
                          {String(optimization.definition.hybrid.dataset_revision ?? '')}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </details>
                <div className="flex items-center justify-between border-t pt-4">
                  <h4 className="text-sm font-semibold">Trial 이력</h4>
                  <span className="text-xs text-muted-foreground">
                    {hybrid ? '예측 평가 · 실제 검증 평가' : '빌드 → 해석 → 후처리'}
                  </span>
                </div>
                {trials.isPending ? (
                  <p role="status" className="text-xs text-muted-foreground">
                    Trial 이력을 불러오는 중…
                  </p>
                ) : !trials.isError && !trials.data?.items.length ? (
                  <p className="py-3 text-xs text-muted-foreground">첫 후보의 평가를 준비하고 있습니다.</p>
                ) : null}
                <ul aria-label="Trial 이력" className="space-y-2">
                  {trials.data?.items.map((trial) => (
                    <TrialHistory
                      key={trial.id}
                      trial={trial}
                      disabled={
                        busy ||
                        executionBusy ||
                        !optimization.continuation.supported ||
                        !['paused', 'completed'].includes(optimization.state)
                      }
                      solverBudgetExhausted={optimization.solver_budget?.remaining === 0}
                      onRetry={() => void data.retry(optimization.id, trial)}
                      onRetryEvaluation={(evaluation) => void data.retryEvaluation(optimization.id, evaluation)}
                    />
                  ))}
                </ul>
                {(trials.data?.total ?? 0) > 20 ? (
                  <div className="flex items-center justify-between text-xs">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={trialOffset === 0}
                      onClick={() => data.pageTrials(trialOffset - 20)}
                    >
                      이전 Trial
                    </Button>
                    <span>{trials.data?.total ?? 0}개 Trial</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={trialOffset + 20 >= (trials.data?.total ?? 0)}
                      onClick={() => data.pageTrials(trialOffset + 20)}
                    >
                      다음 Trial
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : id && detail.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Optimization을 불러오는 중…
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
  onRetryEvaluation,
  solverBudgetExhausted,
}: {
  trial: OptimizationTrial
  disabled: boolean
  onRetry: () => void
  onRetryEvaluation: (evaluation: OptimizationEvaluation) => void
  solverBudgetExhausted: boolean
}) {
  return (
    <li className={cn('rounded-lg border text-xs', trial.state === 'failed' && 'border-destructive/25')}>
      <details className="group/trial p-3">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
          <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-open/trial:rotate-180" />
          <span className="font-medium">Trial {trial.ordinal}</span>
          <OptimizationStatus state={trial.state} />
          <span className="text-muted-foreground">{stageLabels[trial.next_stage]}</span>
          {!trial.evaluations?.length && trial.result ? (
            <span className="ml-auto flex items-center gap-1.5 font-mono">
              {Number(trial.result.objective.toPrecision(7))}
              <span className={cn('font-sans', trial.result.feasible ? 'text-emerald-700' : 'text-destructive')}>
                {trial.result.feasible ? <CheckCircle2 aria-label="제약 충족" className="size-3.5" /> : '제약 위반'}
              </span>
            </span>
          ) : null}
        </summary>
        {trial.evaluations?.length ? (
          trial.evaluations.map((evaluation) => (
            <section
              key={evaluation.id}
              className="mt-3 rounded-md border p-3"
              aria-label={evaluation.kind === 'prediction' ? '예측 평가' : '실제 검증 평가'}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h5 className="font-semibold">{evaluation.kind === 'prediction' ? '예측 평가' : '실제 검증 평가'}</h5>
                <OptimizationStatus state={evaluation.state} />
                <span>{stageLabels[evaluation.next_stage]}</span>
              </div>
              {evaluation.result ? (
                <p className="mt-2 font-mono">
                  목적값 {Number(evaluation.result.objective.toPrecision(7))} ·{' '}
                  {evaluation.result.feasible ? '제약 충족' : '제약 위반'}
                </p>
              ) : null}
              <p className="mt-1 break-all text-muted-foreground">Evaluation {evaluation.id}</p>
              <details className="mt-2">
                <summary className="cursor-pointer">평가 출처</summary>
                <dl className="mt-1 space-y-1 break-all">
                  <dt>평가 정의 hash</dt>
                  <dd className="font-mono">{evaluation.definition_hash}</dd>
                  {evaluation.kind === 'prediction' ? (
                    <>
                      <dt>고정 모델</dt>
                      <dd>
                        {String(evaluation.source.model_id ?? '')} · revision{' '}
                        {String(evaluation.source.model_revision ?? '')}
                      </dd>
                      <dt>모델 checksum</dt>
                      <dd className="font-mono">{String(evaluation.source.checksum ?? '')}</dd>
                    </>
                  ) : (
                    <>
                      <dt>Experiment source</dt>
                      <dd className="font-mono">{String(evaluation.source.source_hash ?? '')}</dd>
                    </>
                  )}
                </dl>
              </details>
              <EvaluationHistory
                evaluation={evaluation}
                disabled={
                  disabled ||
                  (solverBudgetExhausted && evaluation.kind === 'solver' && evaluation.next_stage === 'solve')
                }
                onRetry={() => onRetryEvaluation(evaluation)}
              />
              {solverBudgetExhausted &&
              evaluation.state === 'failed' &&
              evaluation.kind === 'solver' &&
              evaluation.next_stage === 'solve' ? (
                <p className="mt-2 text-muted-foreground">
                  Solver 실행 예산이 소진되어 해석을 다시 실행할 수 없습니다.
                </p>
              ) : null}
            </section>
          ))
        ) : (
          <EvaluationHistory evaluation={trial} disabled={disabled} onRetry={onRetry} />
        )}
        <details className="mt-2">
          <summary className="cursor-pointer">Vars</summary>
          <pre className="max-h-40 overflow-auto">{JSON.stringify(trial.variables, null, 2)}</pre>
        </details>
      </details>
    </li>
  )
}

function EvaluationHistory({
  evaluation,
  disabled,
  onRetry,
}: {
  evaluation: Pick<
    OptimizationTrial,
    'retry_count' | 'error' | 'measurement_id' | 'result' | 'stages' | 'state' | 'manual_retry_requested'
  >
  disabled: boolean
  onRetry: () => void
}) {
  return (
    <>
      <p className="mt-2">수동 재시도 {evaluation.retry_count}회 · 새 Trial 예산을 사용하지 않습니다.</p>
      {evaluation.error ? <p className="mt-2 break-words text-destructive">{evaluation.error.message}</p> : null}
      {evaluation.measurement_id ? <p className="mt-2">Measurement #{evaluation.measurement_id}</p> : null}
      {evaluation.result?.constraints.map((constraint) => (
        <p className="mt-1" key={constraint.key}>
          {constraint.key}: {constraint.value.toPrecision(6)} · {constraint.satisfied ? '충족' : '위반'}
        </p>
      ))}
      {['predict', 'build', 'solve', 'calculate'].map((stage) => {
        const history = evaluation.stages.filter((item) => item.stage === stage)
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
      {evaluation.state === 'failed' ? (
        <Button
          className="mt-2"
          size="sm"
          variant="outline"
          disabled={disabled || evaluation.manual_retry_requested}
          onClick={onRetry}
        >
          {evaluation.manual_retry_requested ? '재시도 접수됨' : '실패 단계 재시도'}
        </Button>
      ) : null}
    </>
  )
}
