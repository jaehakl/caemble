import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { UserData } from '@/api'
import type { CatalogExperimentDetail, CatalogExperimentListItem } from '@/api/catalog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useCaeWorkbenchState } from '@/features/cae-workbench/state/useCaeWorkbenchState'
import {
  catalogExperimentQueryOptions,
  catalogExperimentsInfiniteQueryOptions,
  catalogExperimentsQueryOptions,
} from '@/features/catalog/queryOptions'
import { ExperimentPreview } from './ExperimentPreview'

function TemplatePreview({ detail, user }: { detail: CatalogExperimentDetail; user: UserData | null }) {
  const preview = useCaeWorkbenchState(user, Boolean(user?.is_active))
  const { newExperiment } = preview

  useEffect(() => {
    newExperiment(detail.sourceBundle, detail.title, detail.description, detail.calculations)
  }, [detail, newExperiment])

  return <ExperimentPreview workbench={preview} />
}

export function TemplatesDialog({
  user,
  onClose,
  onApply,
}: {
  user: UserData | null
  onClose: () => void
  onApply: (row: CatalogExperimentDetail) => void
}) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [selected, setSelected] = useState<CatalogExperimentListItem | null>(null)
  const categoriesQuery = useQuery(catalogExperimentsQueryOptions({ q: '', limit: 100 }))
  const categories = useMemo(
    () => [...new Set(categoriesQuery.data?.items.map((item) => item.repository) ?? [])].sort(),
    [categoriesQuery.data],
  )
  const listQuery = useInfiniteQuery(
    catalogExperimentsInfiniteQueryOptions({
      q: search.trim(),
      repository: category ?? undefined,
      limit: 100,
    }),
  )
  const detailQuery = useQuery(catalogExperimentQueryOptions(selected ?? '', selected !== null))

  const selectedDetail = detailQuery.data?.coordinate === selected?.coordinate ? detailQuery.data : undefined

  function resetSelection() {
    setSelected(null)
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex h-[90dvh] w-[95vw] flex-col sm:max-w-[1400px]">
        <DialogHeader>
          <DialogTitle>Templates</DialogTitle>
          <DialogDescription>
            Template을 선택해 Geometry를 확인하고 편집 가능한 로컬 Experiment로 엽니다.
          </DialogDescription>
        </DialogHeader>
        <div aria-label="Template 카테고리" className="flex flex-wrap gap-2" role="group">
          <Button
            aria-pressed={category === null}
            size="sm"
            type="button"
            variant={category === null ? 'default' : 'outline'}
            onClick={() => {
              setCategory(null)
              resetSelection()
            }}
          >
            전체
          </Button>
          {categories.map((value) => (
            <Button
              aria-pressed={category === value}
              key={value}
              size="sm"
              type="button"
              variant={category === value ? 'default' : 'outline'}
              onClick={() => {
                setCategory(value)
                resetSelection()
              }}
            >
              {value}
            </Button>
          ))}
        </div>
        <Input
          aria-label="Template 검색"
          placeholder="Template 검색"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            resetSelection()
          }}
        />
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto rounded-lg border lg:grid-cols-[45%_55%] lg:overflow-hidden">
          <section aria-label="Templates 목록" className="flex h-[280px] min-w-0 flex-col lg:h-auto lg:min-h-0">
            <div className="min-h-0 flex-1 overflow-auto">
              <table className="w-full table-fixed text-left text-xs">
                <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
                  <tr>
                    <th className="w-[42%] px-3 py-2">Solver</th>
                    <th className="px-3 py-2">이름</th>
                  </tr>
                </thead>
                <tbody>
                  {listQuery.data?.pages
                    .flatMap((page) => page.items)
                    .map((row) => {
                      const solverNames = row.relatedSolvers.map((solver) => solver.name).join(', ')
                      return (
                        <tr
                          className={`h-7 cursor-pointer border-b transition-colors focus-within:bg-accent/60 hover:bg-accent/60 ${selected?.coordinate === row.coordinate ? 'bg-accent shadow-[inset_3px_0_0_0_var(--primary)]' : ''}`}
                          key={row.coordinate}
                          onClick={() => setSelected(row)}
                        >
                          <td className="max-w-0 px-3 py-0">
                            <span
                              className="block truncate text-[11px] whitespace-nowrap text-muted-foreground"
                              title={solverNames || undefined}
                            >
                              {solverNames || '—'}
                            </span>
                          </td>
                          <td className="max-w-0 px-3 py-0">
                            <button
                              aria-pressed={selected?.coordinate === row.coordinate}
                              className="h-7 w-full truncate rounded-sm text-left text-xs leading-4 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              title={row.title}
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation()
                                setSelected(row)
                              }}
                            >
                              {row.title}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
              {listQuery.isPending ? (
                <p className="p-3" role="status">
                  Templates를 불러오는 중…
                </p>
              ) : null}
              {listQuery.isError ? (
                <p className="p-3" role="alert">
                  목록을 불러오지 못했습니다.{' '}
                  <button type="button" onClick={() => void listQuery.refetch()}>
                    다시 시도
                  </button>
                </p>
              ) : null}
              {listQuery.isSuccess && !listQuery.data.pages[0]?.items.length ? (
                <p className="p-3">조건에 맞는 Template이 없습니다.</p>
              ) : null}
            </div>
            {listQuery.hasNextPage ? (
              <div className="flex justify-end border-t p-2">
                <Button
                  disabled={listQuery.isFetchingNextPage}
                  type="button"
                  variant="outline"
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  더 보기
                </Button>
              </div>
            ) : null}
          </section>
          <section
            aria-label="Template 상세"
            className="min-h-[320px] min-w-0 border-t bg-muted/10 p-4 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-6"
          >
            {!selected ? (
              <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
                Geometry를 확인할 Template을 선택하세요.
              </p>
            ) : (
              <div className="space-y-6">
                <header className="space-y-3">
                  <h2 className="text-xl leading-snug font-semibold break-words">{selected.title}</h2>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md border bg-background px-2 py-1">{selected.repository}</span>
                    <span className="rounded-md border bg-background px-2 py-1">v{selected.version}</span>
                  </div>
                </header>
                <div
                  aria-label="Template Viewer"
                  className="h-[clamp(280px,38dvh,420px)] overflow-hidden rounded-lg border bg-background"
                >
                  {detailQuery.isPending ? (
                    <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground" role="status">
                      Template 상세 정보를 불러오는 중…
                    </p>
                  ) : detailQuery.isError ? (
                    <div className="grid h-full place-items-center p-6 text-center text-sm" role="alert">
                      <div>
                        <p>Template 상세 정보를 불러오지 못했습니다.</p>
                        <Button
                          className="mt-3"
                          type="button"
                          variant="outline"
                          onClick={() => void detailQuery.refetch()}
                        >
                          Viewer 다시 시도
                        </Button>
                      </div>
                    </div>
                  ) : selectedDetail ? (
                    <TemplatePreview key={selectedDetail.coordinate} detail={selectedDetail} user={user} />
                  ) : null}
                </div>
                {detailQuery.isPending ? (
                  <div aria-hidden="true" className="animate-pulse space-y-2">
                    <div className="h-3 w-full rounded bg-muted" />
                    <div className="h-3 w-2/3 rounded bg-muted" />
                  </div>
                ) : detailQuery.isSuccess && selectedDetail ? (
                  <>
                    {selectedDetail.description.trim() ? (
                      <section className="space-y-2">
                        <h3 className="text-sm font-semibold">설명</h3>
                        <p className="text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                          {selectedDetail.description}
                        </p>
                      </section>
                    ) : null}
                    {selectedDetail.concepts.length ? (
                      <section className="space-y-3">
                        <h3 className="text-sm font-semibold">Concepts</h3>
                        <div className="flex flex-wrap gap-2">
                          {selectedDetail.concepts.map((concept) => (
                            <span
                              key={concept}
                              className="max-w-full rounded-md bg-muted px-2 py-1 text-xs leading-5 break-words"
                            >
                              {concept}
                            </span>
                          ))}
                        </div>
                      </section>
                    ) : null}
                    {selectedDetail.relatedSolvers.length ? (
                      <section className="space-y-3">
                        <h3 className="text-sm font-semibold">관련 Solvers</h3>
                        <ul className="divide-y rounded-lg border bg-background px-4">
                          {selectedDetail.relatedSolvers.map((solver) => (
                            <li key={solver.name + solver.version} className="space-y-1 py-3">
                              <p className="text-sm font-medium break-words">
                                {solver.name}{' '}
                                <span className="text-xs font-normal text-muted-foreground">v{solver.version}</span>
                              </p>
                              {solver.description ? (
                                <p className="text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                                  {solver.description}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {selectedDetail.calculations.length ? (
                      <section className="space-y-3">
                        <h3 className="text-sm font-semibold">포함된 Calculations</h3>
                        <ul className="divide-y rounded-lg border bg-background px-4">
                          {selectedDetail.calculations.map((calculation) => (
                            <li key={calculation.name} className="space-y-1 py-3">
                              <p className="text-sm font-medium break-words">{calculation.name}</p>
                              {calculation.description ? (
                                <p className="text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                                  {calculation.description}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    <details className="border-t pt-4 text-xs text-muted-foreground">
                      <summary className="cursor-pointer rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        추가 정보
                      </summary>
                      <p className="mt-3 leading-5 break-all">{selectedDetail.coordinate}</p>
                    </details>
                  </>
                ) : null}
              </div>
            )}
          </section>
        </div>
        <footer className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={!selectedDetail || !detailQuery.isSuccess}
            type="button"
            onClick={() => {
              if (selectedDetail) onApply(selectedDetail)
            }}
          >
            적용
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
