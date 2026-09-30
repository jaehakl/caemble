import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { getListRequest } from '@/api'
import { optimizationApi } from '@/api/optimization'
import { Button } from '@/components/ui/button'
import type { OptimizationStudy } from '@/contracts/api/optimization'
import { useAuth } from '@/features/auth/use-auth'
import type { CaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import { calculationsQueryOptions } from '@/features/calculation/queryOptions'
import { OptimizationVariables } from './OptimizationVariables'
import { optimizationAxes, optimizationVariables, validateOptimizationAxes } from './variables'
import { optimizationQueryKeys } from './queryKeys'

type ConstraintDraft = { calculationId: string; minimum: string; maximum: string }

export function OptimizationSetup({
  workbench,
  onCreated,
}: {
  workbench: CaeWorkbenchState
  onCreated: (study: OptimizationStudy) => void
}) {
  const { queryScope } = useAuth()
  const client = useQueryClient()
  const schema = workbench.experimentDocument.varsSchema!
  const variables = workbench.candidateVars ?? workbench.experimentDocument.variables!
  const [axes, setAxes] = useState(() => optimizationAxes(schema))
  const [name, setName] = useState(`${workbench.experimentName} 최적화`)
  const [objectiveId, setObjectiveId] = useState(String(workbench.selectionContext.calculationId ?? ''))
  const [direction, setDirection] = useState<'minimize' | 'maximize'>('minimize')
  const [constraints, setConstraints] = useState<ConstraintDraft[]>([])
  const [maxTrials, setMaxTrials] = useState(20)
  const [maxParallel, setMaxParallel] = useState(2)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<{ fingerprint: string; id: string } | null>(null)
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
  const eligible =
    workbench.experimentClean &&
    workbench.experimentManageable &&
    !workbench.selectionRestoring &&
    workbench.experimentSourceValidated &&
    !workbench.experimentDocument.runIsBusy
  const optionItems = choices.map((row) => (
    <option key={row.id} value={row.id}>
      {row.name}
      {row.contract_status === 'ready' ? '' : ' · 첫 평가에서 검증'}
    </option>
  ))

  async function start() {
    if (!eligible || submitting || workbench.experimentId === null) return
    setSubmitting(true)
    setError(null)
    try {
      validateOptimizationAxes(axes, variables, schema)
      const initialVars = optimizationVariables(variables, schema)
      if (!choices.some((row) => row.id === Number(objectiveId)))
        throw new Error('스칼라 Calculation을 목적함수로 선택하세요.')
      if (!Number.isSafeInteger(maxTrials) || maxTrials < 1 || !Number.isSafeInteger(maxParallel) || maxParallel < 1)
        throw new Error('평가 횟수와 동시 후보 수는 양의 정수여야 합니다.')
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
      }
      const fingerprint = JSON.stringify(payload)
      if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
      const study = await optimizationApi.create({
        ...payload,
        vars_schema: JSON.parse(JSON.stringify(schema)),
        request_id: request.current.id,
      })
      await client.invalidateQueries({ queryKey: optimizationQueryKeys.lists(queryScope) })
      onCreated(study)
      request.current = null
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        void start()
      }}
    >
      <h2 className="font-semibold">새 Study</h2>
      <label className="block space-y-1 text-sm">
        <span>이름</span>
        <input
          className="w-full rounded border bg-background px-2 py-1"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <OptimizationVariables schema={schema} variables={variables} axes={axes} onChange={setAxes} />
      <fieldset className="space-y-2 rounded border p-3 text-sm">
        <legend className="px-1">목적함수</legend>
        <select
          className="w-full rounded border bg-background p-1"
          aria-label="목적함수 Calculation"
          value={objectiveId}
          onChange={(event) => setObjectiveId(event.target.value)}
        >
          <option value="">Calculation 선택</option>
          {optionItems}
        </select>
        <select
          className="rounded border bg-background p-1"
          aria-label="목적 방향"
          value={direction}
          onChange={(event) => setDirection(event.target.value as typeof direction)}
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
      <fieldset className="space-y-2 rounded border p-3 text-sm">
        <legend className="px-1">제약조건</legend>
        {constraints.map((constraint, index) => (
          <div className="space-y-1" key={index}>
            <select
              className="w-full rounded border bg-background p-1"
              aria-label={`제약조건 ${index + 1} Calculation`}
              value={constraint.calculationId}
              onChange={(event) =>
                setConstraints((current) =>
                  current.map((item, at) => (at === index ? { ...item, calculationId: event.target.value } : item)),
                )
              }
            >
              <option value="">Calculation 선택</option>
              {optionItems}
            </select>
            <div className="flex items-center gap-2">
              {(['minimum', 'maximum'] as const).map((bound) => (
                <input
                  className="min-w-0 flex-1 rounded border bg-background p-1"
                  key={bound}
                  type="number"
                  step="any"
                  placeholder={bound === 'minimum' ? '하한 (선택)' : '상한 (선택)'}
                  aria-label={`제약조건 ${index + 1} ${bound}`}
                  value={constraint[bound]}
                  onChange={(event) =>
                    setConstraints((current) =>
                      current.map((item, at) => (at === index ? { ...item, [bound]: event.target.value } : item)),
                    )
                  }
                />
              ))}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConstraints((current) => current.filter((_item, at) => at !== index))}
              >
                삭제
              </Button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setConstraints((current) => [...current, { calculationId: '', minimum: '', maximum: '' }])}
        >
          제약조건 추가
        </Button>
      </fieldset>
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="space-y-1">
          <span className="block">최대 평가 횟수</span>
          <input
            className="w-24 rounded border bg-background p-1"
            type="number"
            min="1"
            max="10000"
            required
            value={Number.isFinite(maxTrials) ? maxTrials : ''}
            onChange={(event) => setMaxTrials(event.target.valueAsNumber)}
          />
        </label>
        <label className="space-y-1">
          <span className="block">동시 후보 수</span>
          <input
            className="w-24 rounded border bg-background p-1"
            type="number"
            min="1"
            max="64"
            required
            value={Number.isFinite(maxParallel) ? maxParallel : ''}
            onChange={(event) => setMaxParallel(event.target.valueAsNumber)}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        현재 Candidate를 첫 후보로 평가합니다. 시작 후 소스와 평가 설정은 고정됩니다.
      </p>
      {!eligible ? (
        <p role="status" className="text-xs text-muted-foreground">
          저장된 Experiment와 현재 Candidate의 소스 검증이 필요합니다.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={!eligible || submitting || calculations.isPending}>
        {submitting ? '등록 중…' : '최적화 시작'}
      </Button>
    </form>
  )
}
