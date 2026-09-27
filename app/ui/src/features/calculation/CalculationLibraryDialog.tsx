import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ChevronDown, LoaderCircle } from 'lucide-react'
import {
  calculationLibraryApi,
  type CalculationLibraryDetail,
  type CalculationLibraryQuery,
  type CalculationLibraryReference,
} from '@/api/calculationLibrary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import {
  CALCULATION_INPUT_MAX_BYTES,
  CALCULATION_OUTPUT_MAX_ELEMENTS,
  CALCULATION_TIMEOUT_MS,
  calculationDtypes,
  calculationInputDtypes,
} from '@/lib/calculation'
import { calculationLibraryInputs } from './calculationLibraryPreview'

const sourceLabels = { catalog: 'Catalog', mine: '내 항목', demo: '공개 Demo' }
const initialQuery: CalculationLibraryQuery = {
  source: 'all',
  query: '',
  solver_names: [],
  solver_name: '',
  solver_version: '',
  concept: '',
  unclassified: false,
  offset: 0,
  limit: 30,
}

function InputPreview({ detail }: { detail: CalculationLibraryDetail }) {
  const inputs = calculationLibraryInputs(detail)
  return (
    <section className="space-y-3">
      <h3 className="font-semibold">참조하는 Record</h3>
      {inputs.error ? <p>{inputs.error}</p> : <p>{inputs.items.map((item) => item.name).join(', ') || '없음'}</p>}
      <p>현재 Experiment의 Record와 Measurement로 실행하여 입력과 출력 구성을 확인합니다.</p>
      <details>
        <summary>공통 실행 제약조건</summary>
        <p>
          Input: {calculationInputDtypes.join(', ')} · 최대 {CALCULATION_INPUT_MAX_BYTES / 1024 / 1024} MiB
        </p>
        <p>
          Output: {calculationDtypes.join(', ')} · 최대 {CALCULATION_OUTPUT_MAX_ELEMENTS.toLocaleString()}개 원소
        </p>
        <p>실행 제한: {CALCULATION_TIMEOUT_MS / 1000}초</p>
      </details>
    </section>
  )
}

export function CalculationLibraryDialog({
  defaultSolverNames,
  loadDisabled,
  onClose,
  onLoad,
}: {
  defaultSolverNames: readonly string[]
  loadDisabled: boolean
  onClose: () => void
  onLoad: (detail: CalculationLibraryDetail) => boolean
}) {
  const scope = usePrivateQueryScope()
  const [query, setQuery] = useState<CalculationLibraryQuery>(() => ({
    ...initialQuery,
    solver_names: [...new Set(defaultSolverNames)].sort(),
  }))
  const [initialSolverNames] = useState(() => [...new Set(defaultSolverNames)])
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
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" aria-label="Solver" className="w-full justify-between">
                    {query.solver_names.length ? `Solver ${query.solver_names.length}개 선택` : '전체 Solver'}
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="max-h-72 overflow-y-auto">
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault()
                      changeFilters({ solver_names: [] })
                    }}
                  >
                    전체 Solver (선택 해제)
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {[...new Set([...initialSolverNames, ...(facets?.solvers.map((solver) => solver.name) ?? [])])]
                    .sort()
                    .map((name) => (
                      <DropdownMenuCheckboxItem
                        key={name}
                        checked={query.solver_names.includes(name)}
                        onSelect={(event) => event.preventDefault()}
                        onCheckedChange={(checked) =>
                          changeFilters({
                            solver_names: checked
                              ? [...new Set([...query.solver_names, name])].sort()
                              : query.solver_names.filter((selected) => selected !== name),
                          })
                        }
                      >
                        {name}
                      </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
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
                <InputPreview detail={detail.data} />
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
            저장 시 공유 정의에 연결합니다. 현재 Experiment의 입력으로 다시 검증해야 합니다.
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
