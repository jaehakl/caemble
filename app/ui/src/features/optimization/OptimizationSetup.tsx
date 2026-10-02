import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowRight, ChevronDown, LoaderCircle, Plus, Target, Trash2 } from 'lucide-react'
import { getListRequest } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { calculationsQueryOptions } from '@/features/calculation/queryOptions'
import { OptimizationVariables } from './OptimizationVariables'
import { OptimizationHybridSettings } from './OptimizationHybridSettings'
import { optimizationVariables, validateOptimizationAxes } from './variables'
import type { OptimizationDraft } from './optimizationDraft'
import type { useOptimizationCreation } from './useOptimizationData'

export function OptimizationSetup({
  workbench,
  draft,
  onDraftChange,
  creation,
}: {
  workbench: CaeWorkbenchState
  draft: OptimizationDraft
  onDraftChange: (draft: OptimizationDraft) => void
  creation: ReturnType<typeof useOptimizationCreation>
}) {
  const { queryScope } = useAuth()
  const schema = workbench.experimentDocument.varsSchema!
  const variables = workbench.candidateVars ?? workbench.experimentDocument.variables!
  const { axes, name, objectiveId, direction, constraints, maxTrials, maxParallel } = draft
  const submitting = creation.pending
  const [validationError, setValidationError] = useState<string | null>(null)
  const error = validationError ?? creation.error
  const updateDraft = (change: Partial<OptimizationDraft>) => onDraftChange({ ...draft, ...change })
  const calculations = useQuery({
    ...calculationsQueryOptions(queryScope, workbench.experimentId, {
      ...getListRequest('visible'),
      filter: { experiment_id: [workbench.experimentId!, workbench.experimentId!] },
      limit: null,
    }),
    enabled: workbench.experimentId !== null,
  })
  const rows = calculations.data?.items ?? []
  const choices = rows.filter((row) => row.contract_status !== 'ready' || row.output_layout?.shape.length === 0)
  const blockedReason = workbench.selectionRestoring
    ? 'Candidate를 복원하고 있습니다.'
    : !workbench.experimentManageable
      ? '편집 권한이 있는 Experiment에서 시작할 수 있습니다.'
      : !workbench.experimentClean
        ? '변경한 Experiment를 먼저 저장하세요.'
        : workbench.experimentDocument.runIsBusy
          ? '현재 Candidate의 실행이 끝나면 시작할 수 있습니다.'
          : !workbench.experimentSourceValidated || !workbench.experimentRecord?.source_hash
            ? '시뮬레이션에서 현재 소스를 검증하고 Candidate를 준비하세요.'
            : null
  const eligible = blockedReason === null
  const searchableAxes = axes.filter((axis) => !axis.fixed && axis.min !== axis.max).length
  const optionItems = choices.map((row) => (
    <option key={row.id} value={row.id}>
      {row.name}
      {row.contract_status === 'ready' ? '' : ' · 첫 평가에서 검증'}
    </option>
  ))

  async function start() {
    if (!eligible || submitting || workbench.experimentId === null) return
    setValidationError(null)
    try {
      validateOptimizationAxes(axes, variables, schema)
      const initialVars = optimizationVariables(variables, schema)
      if (!name.trim()) throw new Error('최적화 이름을 입력하세요.')
      if (!choices.some((row) => row.id === Number(objectiveId)))
        throw new Error('스칼라 Calculation을 목적함수로 선택하세요.')
      if (
        !Number.isSafeInteger(maxTrials) ||
        maxTrials < 1 ||
        maxTrials > 10000 ||
        !Number.isSafeInteger(maxParallel) ||
        maxParallel < 1 ||
        maxParallel > 64
      )
        throw new Error('평가 횟수는 1–10,000, 동시 후보 수는 1–64 사이의 정수여야 합니다.')
      const parsedConstraints = constraints.map((constraint) => {
        const minimum = constraint.minimum.trim() === '' ? undefined : Number(constraint.minimum)
        const maximum = constraint.maximum.trim() === '' ? undefined : Number(constraint.maximum)
        if (
          !choices.some((row) => row.id === Number(constraint.calculationId)) ||
          (minimum === undefined && maximum === undefined) ||
          (minimum !== undefined && !Number.isFinite(minimum)) ||
          (maximum !== undefined && !Number.isFinite(maximum)) ||
          (minimum !== undefined && maximum !== undefined && minimum > maximum)
        )
          throw new Error('제약조건의 Calculation과 유효한 상·하한을 입력하세요.')
        return {
          calculation_id: Number(constraint.calculationId),
          ...(minimum === undefined ? {} : { minimum }),
          ...(maximum === undefined ? {} : { maximum }),
        }
      })
      if (draft.hybrid && (!draft.modelId || !draft.modelRevision || !draft.replicaId || !draft.launcherId))
        throw new Error('저장된 Forward 모델, revision과 실행 위치를 선택하세요.')
      if (
        draft.hybrid &&
        (!Number.isSafeInteger(draft.maxSolverRuns) || draft.maxSolverRuns < 1 || draft.maxSolverRuns > 10000)
      )
        throw new Error('Solver 실행 시도 예산은 1–10,000 사이의 정수여야 합니다.')
      const qualityRequirements = (draft.hybrid ? draft.qualityRequirements : []).map((requirement) => {
        const maximum = Number(requirement.rmseMaximum)
        if (!requirement.rmseMaximum.trim() || !Number.isFinite(maximum) || maximum < 0)
          throw new Error('RMSE 상한은 0 이상의 유한한 값이어야 합니다.')
        return { ...requirement, rmseMaximum: maximum }
      })
      const payload = {
        name: name.trim(),
        experiment_id: workbench.experimentId,
        source_hash: workbench.experimentRecord!.source_hash!,
        vars_schema: schema,
        initial_vars: initialVars,
        axes,
        objective: { calculation_id: Number(objectiveId), direction },
        constraints: parsedConstraints,
        max_trials: maxTrials,
        max_parallel: maxParallel,
        ...(draft.hybrid
          ? {
              hybrid: {
                model_id: draft.modelId,
                model_revision: Number(draft.modelRevision),
                replica_id: draft.replicaId,
                launcher_id: draft.launcherId,
                max_solver_runs: draft.maxSolverRuns,
                ...(qualityRequirements.length ? { quality_requirements: qualityRequirements } : {}),
              },
            }
          : {}),
      }
      await creation.create(payload)
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        void start()
      }}
    >
      <fieldset disabled={submitting} className="min-w-0 flex-1 space-y-5 p-5 disabled:opacity-60">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">이름</span>
          <Input
            required
            maxLength={200}
            value={name}
            onChange={(event) => updateDraft({ name: event.target.value })}
          />
        </label>
        <fieldset className="space-y-3 rounded-lg border p-4 text-sm">
          <legend className="px-1 font-medium">목적함수</legend>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Target className="size-3.5" />
            개선할 스칼라 Calculation을 선택하세요.
          </p>
          <select
            className="h-9 w-full min-w-0 rounded-md border bg-background px-2 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="목적함수 Calculation"
            value={objectiveId}
            required
            disabled={calculations.isPending || calculations.isError}
            onChange={(event) => updateDraft({ objectiveId: event.target.value })}
          >
            <option value="">{calculations.isPending ? 'Calculation 불러오는 중…' : 'Calculation 선택'}</option>
            {optionItems}
          </select>
          <select
            className="h-9 w-full rounded-md border bg-background px-2 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="목적 방향"
            value={direction}
            onChange={(event) => updateDraft({ direction: event.target.value as typeof direction })}
          >
            <option value="minimize">최소화</option>
            <option value="maximize">최대화</option>
          </select>
          {!choices.length && !calculations.isPending ? (
            <p className="text-xs text-muted-foreground">후처리에서 스칼라 값을 반환하는 Calculation을 저장하세요.</p>
          ) : null}
          {calculations.isError ? (
            <p role="alert" className="text-destructive">
              Calculation 목록을 불러오지 못했습니다.
            </p>
          ) : null}
        </fieldset>
        <details className="group rounded-lg border" open={axes.length <= 8}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span>
              탐색 변수{' '}
              <span className="ml-1 font-normal text-muted-foreground">
                {searchableAxes} / {axes.length}
              </span>
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t p-3">
            <OptimizationVariables
              schema={schema}
              variables={variables}
              axes={axes}
              onChange={(axes) => updateDraft({ axes })}
            />
          </div>
        </details>
        <fieldset className="space-y-3 rounded-lg border p-4 text-sm">
          <legend className="px-1 font-medium">
            제약조건 <span className="font-normal text-muted-foreground">선택</span>
          </legend>
          {!constraints.length ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              허용할 결과의 하한 또는 상한을 지정합니다. 조건이 없으면 목적값만으로 후보를 비교합니다.
            </p>
          ) : null}
          {constraints.map((constraint, index) => (
            <div className="space-y-2 rounded-md bg-muted/40 p-2" key={index}>
              <select
                className="h-9 w-full min-w-0 rounded-md border bg-background px-2 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`제약조건 ${index + 1} Calculation`}
                value={constraint.calculationId}
                onChange={(event) =>
                  updateDraft({
                    constraints: constraints.map((item, at) =>
                      at === index ? { ...item, calculationId: event.target.value } : item,
                    ),
                  })
                }
              >
                <option value="">Calculation 선택</option>
                {optionItems}
              </select>
              <div className="flex items-center gap-2">
                {(['minimum', 'maximum'] as const).map((bound) => (
                  <Input
                    className="min-w-0 flex-1"
                    key={bound}
                    type="number"
                    step="any"
                    placeholder={bound === 'minimum' ? '하한 (선택)' : '상한 (선택)'}
                    aria-label={`제약조건 ${index + 1} ${bound}`}
                    value={constraint[bound]}
                    onChange={(event) =>
                      updateDraft({
                        constraints: constraints.map((item, at) =>
                          at === index ? { ...item, [bound]: event.target.value } : item,
                        ),
                      })
                    }
                  />
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  aria-label={`제약조건 ${index + 1} 삭제`}
                  onClick={() => updateDraft({ constraints: constraints.filter((_item, at) => at !== index) })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateDraft({ constraints: [...constraints, { calculationId: '', minimum: '', maximum: '' }] })
            }
          >
            <Plus className="size-3.5" />
            제약조건 추가
          </Button>
        </fieldset>
        <fieldset className="space-y-3 rounded-lg border p-4 text-sm">
          <legend className="px-1 font-medium">평가 방식</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.hybrid}
              onChange={(event) => updateDraft({ hybrid: event.target.checked })}
            />
            Forward Hybrid Optimization
          </label>
          {draft.hybrid && workbench.experimentId !== null ? (
            <OptimizationHybridSettings experimentId={workbench.experimentId} draft={draft} onChange={updateDraft} />
          ) : (
            <p className="text-xs text-muted-foreground">모든 후보를 실제 Solver로 평가합니다.</p>
          )}
        </fieldset>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="space-y-1">
            <span className="block">최대 후보 수</span>
            <Input
              className="w-full"
              type="number"
              min="1"
              max="10000"
              required
              value={Number.isFinite(maxTrials) ? maxTrials : ''}
              onChange={(event) => updateDraft({ maxTrials: event.target.valueAsNumber })}
            />
          </label>
          <label className="space-y-1">
            <span className="block">동시 후보 수</span>
            <Input
              className="w-full"
              type="number"
              min="1"
              max="64"
              required
              value={Number.isFinite(maxParallel) ? maxParallel : ''}
              onChange={(event) => updateDraft({ maxParallel: event.target.valueAsNumber })}
            />
          </label>
        </div>
        {searchableAxes === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            모든 변수가 고정되어 현재 Candidate를 한 번 평가하고 완료합니다.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          현재 Candidate를 첫 후보로 평가합니다. 시작 후 소스와 평가 설정은 고정됩니다.
        </p>
      </fieldset>
      <div className="sticky bottom-0 space-y-3 border-t bg-background p-4">
        {blockedReason ? (
          <p role="status" className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
            {blockedReason}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          className="w-full"
          type="submit"
          disabled={!eligible || submitting || calculations.isPending || calculations.isError || !choices.length}
        >
          {submitting ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
          {submitting ? '등록 중…' : '최적화 시작'}
        </Button>
      </div>
    </form>
  )
}
