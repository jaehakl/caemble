import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import {
  calculationLibraryApi,
  type CalculationLibraryDetail,
  type CalculationLibraryQuery,
  type CalculationLibraryReference,
} from '@/api/calculationLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CALCULATION_TIMEOUT_MS,
  calculationDtypes,
  calculationInputDtypes,
} from '@/lib/calculation'
import { calculationLibraryInputs, libraryInputShape } from './calculationLibraryPreview'

const sourceLabels = { catalog: 'Catalog', mine: '내 항목', demo: '공개 Demo' }
const initialQuery: CalculationLibraryQuery = {
  source: 'all',
  query: '',
  solver_name: '',
  solver_version: '',
  concept: '',
  unclassified: false,
  quantity_kind: '',
  offset: 0,
  limit: 30,
}

function ContractPreview({ detail }: { detail: CalculationLibraryDetail }) {
  const inputs = calculationLibraryInputs(detail)
  return (
    <>
      <h3 className="font-semibold">Input</h3>
      <p className="text-muted-foreground">shape의 ?는 동적·미확인 차원입니다.</p>
      {inputs.error ? <p className="text-destructive">입력 참조 분석 실패: {inputs.error}</p> : null}
      {!inputs.items.length ? (
        <p className="text-muted-foreground">{inputs.error ? '동적·미확인' : '참조하는 Record 없음'}</p>
      ) : null}
      {inputs.items.map(({ name, contract }) => (
        <section key={name} className="space-y-1 rounded border p-3">
          <div className="font-mono font-medium break-all">{name}</div>
          <p className="text-muted-foreground">
            {contract ? '저장 계약' : '정적으로 확인된 Record 참조 · 계약 미확인'}
          </p>
          <p>shape: {libraryInputShape(contract?.data_schema)}</p>
          {contract ? (
            <>
              <p>
                dtype: {contract.dtype} · QuantityKind: {contract.quantity_kind ?? '미확인'} · tensorOrder:{' '}
                {contract.tensor_order}
              </p>
              <p>단위: {typeof contract.data_schema?.unit === 'string' ? contract.data_schema.unit : '미확인'}</p>
              <details>
                <summary className="cursor-pointer">축·스키마 제약조건</summary>
                <pre className="mt-2 max-h-60 overflow-auto break-all whitespace-pre-wrap">
                  {JSON.stringify(contract.data_schema, null, 2)}
                </pre>
              </details>
            </>
          ) : null}
        </section>
      ))}
      <h3 className="font-semibold">Output</h3>
      {detail.output_layout ? (
        <section className="space-y-1 rounded border p-3">
          <p>저장 계약 · 원본 preflight Measurement #{detail.preflight_measurement_id ?? '미확인'} 기준</p>
          <p>
            dtype: {detail.output_layout.dtype} · shape: [{detail.output_layout.shape.join(', ')}]
          </p>
          {detail.output_layout.axes.map((axis, index) => (
            <p key={index}>
              {axis.name}: {axis.ticks.length}개 · 단위 {axis.unit ?? '미확인'}
            </p>
          ))}
          <details>
            <summary className="cursor-pointer">축 상세</summary>
            <pre className="max-h-60 overflow-auto break-all whitespace-pre-wrap">
              {JSON.stringify(detail.output_layout.axes, null, 2)}
            </pre>
          </details>
        </section>
      ) : (
        <p className="text-muted-foreground">동적·미확인 · 현재 Measurement에서 preflight 후 확인할 수 있습니다.</p>
      )}
      <p className="text-muted-foreground">
        원본 계약은 현재 Experiment와의 호환성을 보장하지 않습니다. 코드 내부의 추가 조건은 실행 전 확정하지 않습니다.
      </p>
      <details>
        <summary className="cursor-pointer">공통 실행 제약조건</summary>
        <p>
          Input: {calculationInputDtypes.join(', ')} · 최대 {CALCULATION_INPUT_MAX_BYTES / 1024 / 1024} MiB
        </p>
        <p>
          Output: {calculationDtypes.join(', ')} · 최대 {CALCULATION_OUTPUT_MAX_ELEMENTS.toLocaleString()}개 원소
        </p>
        <p>실행 제한: {CALCULATION_TIMEOUT_MS / 1000}초</p>
      </details>
    </>
  )
}

export function CalculationLibraryDialog({
  authenticated,
  loadDisabled,
  onClose,
  onLoad,
}: {
  authenticated: boolean
  loadDisabled: boolean
  onClose: () => void
  onLoad: (detail: CalculationLibraryDetail) => boolean
}) {
  const scope = usePrivateQueryScope()
  const [query, setQuery] = useState(initialQuery)
  const [selection, setSelection] = useState<CalculationLibraryReference | null>(null)
  const list = useQuery({
    queryKey: ['calculation-library', scope, 'list', query],
    queryFn: ({ signal }) => calculationLibraryApi.list(query, { signal }),
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === scope ? previous : undefined),
    retry: false,
  })
  const detail = useQuery({
    queryKey: ['calculation-library', scope, 'detail', selection],
    queryFn: ({ signal }) => calculationLibraryApi.detail(selection!, { signal }),
    enabled: selection !== null,
    retry: false,
  })
  const changeFilters = (patch: Partial<CalculationLibraryQuery>) => {
    setQuery((previous) => ({ ...previous, ...patch, offset: 0 }))
    setSelection(null)
  }
  const facets = list.data?.facets
  const selectClass = 'h-9 w-full min-w-0 rounded-md border bg-background px-2 text-sm'
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[85dvh] max-h-[900px] w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-6xl"
      >
        <DialogHeader>
          <DialogTitle>Calculation 불러오기</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[minmax(260px,2fr)_3fr]">
          <section aria-label="Calculation 라이브러리 목록" className="flex min-h-0 flex-col gap-2">
            <Input
              aria-label="Calculation 검색"
              placeholder="이름, 설명, Experiment 검색"
              value={query.query}
              onChange={(event) => changeFilters({ query: event.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label="출처"
                className={selectClass}
                value={query.source}
                onChange={(event) =>
                  changeFilters({
                    source: event.target.value as CalculationLibraryQuery['source'],
                    solver_name: '',
                    solver_version: '',
                    concept: '',
                    unclassified: false,
                    quantity_kind: '',
                  })
                }
              >
                <option value="all">전체 출처</option>
                <option value="catalog">Catalog</option>
                <option value="mine" disabled={!authenticated}>
                  내 항목
                </option>
                <option value="demo">공개 Demo</option>
              </select>
              <select
                aria-label="Solver"
                className={selectClass}
                value={query.solver_name}
                onChange={(event) => changeFilters({ solver_name: event.target.value, solver_version: '' })}
              >
                <option value="">전체 Solver</option>
                {[...new Set(facets?.solvers.map((solver) => solver.name))].map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              <select
                aria-label="Solver 버전"
                className={selectClass}
                value={query.solver_version}
                onChange={(event) => changeFilters({ solver_version: event.target.value })}
              >
                <option value="">전체 버전</option>
                {[
                  ...new Set(
                    facets?.solvers
                      .filter((solver) => !query.solver_name || solver.name === query.solver_name)
                      .map((solver) => solver.version),
                  ),
                ].map((version) => (
                  <option key={version}>{version}</option>
                ))}
              </select>
              <select
                aria-label="Concept 분류"
                className={selectClass}
                value={query.unclassified ? '__unclassified' : query.concept}
                onChange={(event) =>
                  changeFilters({
                    concept: event.target.value === '__unclassified' ? '' : event.target.value,
                    unclassified: event.target.value === '__unclassified',
                  })
                }
              >
                <option value="">전체 Concept</option>
                <option value="__unclassified">미분류</option>
                {facets?.concepts.map((concept) => (
                  <option key={concept}>{concept}</option>
                ))}
              </select>
              <select
                aria-label="입력 QuantityKind"
                className={`${selectClass} col-span-2`}
                value={query.quantity_kind}
                onChange={(event) => changeFilters({ quantity_kind: event.target.value })}
              >
                <option value="">전체 입력 QuantityKind</option>
                {facets?.quantity_kinds.map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
            </div>
            <div className="min-h-20 flex-1 overflow-auto rounded border">
              {list.isPending || list.isPlaceholderData ? (
                <LoaderCircle aria-label="목록 불러오는 중" className="m-4 animate-spin" />
              ) : list.isError ? (
                <div className="p-3">
                  목록을 불러오지 못했습니다.
                  <Button variant="outline" onClick={() => void list.refetch()}>
                    다시 시도
                  </Button>
                </div>
              ) : !list.data?.items.length ? (
                <p className="p-3 text-muted-foreground">검색 결과가 없습니다.</p>
              ) : (
                list.data.items.map((item) => {
                  const key = JSON.stringify(item.reference)
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={key === JSON.stringify(selection)}
                      onClick={() => setSelection(item.reference)}
                      className="block w-full space-y-1 border-b p-3 text-left text-sm hover:bg-accent aria-pressed:bg-accent"
                    >
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.sources.map((source) => sourceLabels[source]).join(' · ')} · {item.experiment_name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {item.solvers.map((solver) => `${solver.name}@${solver.version}`).join(', ') || 'Solver 미확인'}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
            <div className="flex items-center justify-between text-xs">
              <Button
                variant="outline"
                disabled={query.offset === 0 || list.isFetching}
                onClick={() => {
                  setQuery({ ...query, offset: Math.max(0, query.offset - query.limit) })
                  setSelection(null)
                }}
              >
                이전
              </Button>
              <span>
                {list.data?.total ?? 0}개 · {Math.floor(query.offset / query.limit) + 1}페이지
              </span>
              <Button
                variant="outline"
                disabled={list.isFetching || query.offset + query.limit >= (list.data?.total ?? 0)}
                onClick={() => {
                  setQuery({ ...query, offset: query.offset + query.limit })
                  setSelection(null)
                }}
              >
                다음
              </Button>
            </div>
          </section>
          <section aria-label="Calculation 상세" className="min-h-0 space-y-3 overflow-auto rounded border p-4 text-sm">
            {!selection ? (
              <p className="text-muted-foreground">Calculation을 선택하면 코드와 입출력 계약을 확인할 수 있습니다.</p>
            ) : detail.isPending ? (
              <LoaderCircle aria-label="상세 불러오는 중" className="animate-spin" />
            ) : detail.isError ? (
              <div>
                상세를 불러오지 못했습니다.
                <Button variant="outline" onClick={() => void detail.refetch()}>
                  다시 시도
                </Button>
              </div>
            ) : detail.data ? (
              <>
                <h2 className="text-lg font-semibold">{detail.data.name}</h2>
                <p className="whitespace-pre-wrap">{detail.data.description}</p>
                <p>
                  {detail.data.sources.map((source) => sourceLabels[source]).join(' · ')} ·{' '}
                  {detail.data.experiment_name}
                </p>
                <p className="break-all text-muted-foreground">{detail.data.experiment_coordinate}</p>
                <p>
                  Solver:{' '}
                  {detail.data.solvers.map((solver) => `${solver.name}@${solver.version}`).join(', ') || '미확인'}
                </p>
                <p>Concept: {detail.data.concepts.join(', ') || '미분류'}</p>
                <ContractPreview detail={detail.data} />
                <details open>
                  <summary className="cursor-pointer font-semibold">코드 (읽기 전용)</summary>
                  <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{detail.data.source_code}</pre>
                </details>
              </>
            ) : null}
          </section>
        </div>
        <footer className="flex items-center justify-end gap-2">
          <p className="mr-auto text-xs text-muted-foreground">
            불러온 코드는 새 초안입니다. 저장 시 현재 Experiment에 추가됩니다.
          </p>
          <Button variant="outline" onClick={onClose}>
            닫기
          </Button>
          <Button
            disabled={loadDisabled || !selection || !detail.data || detail.isFetching || detail.isError}
            onClick={() => {
              if (detail.data && onLoad(detail.data)) onClose()
            }}
          >
            불러오기
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
