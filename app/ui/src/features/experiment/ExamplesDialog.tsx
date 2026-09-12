import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { catalogApi, type CatalogExperimentDetail, type CatalogExperimentListItem } from '@/api/catalog'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function ExamplesDialog({
  onClose,
  onApply,
}: {
  onClose: () => void
  onApply: (row: CatalogExperimentDetail) => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<CatalogExperimentListItem | null>(null)
  const [pending, setPending] = useState(false)
  const query = useInfiniteQuery({
    queryKey: ['catalog', 'experiment-picker', search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      catalogApi.listExperiments({ q: search.trim(), limit: 100, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] w-[90vw] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Examples</DialogTitle>
          <DialogDescription>Catalog 예제를 선택해 편집 가능한 로컬 Experiment로 엽니다.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Catalog 예제 검색"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSelected(null)
          }}
          placeholder="예제 검색"
        />
        <div className="min-h-0 overflow-auto">
          <table className="w-full table-fixed text-left text-sm">
            <thead>
              <tr>
                <th className="w-1/4 p-2">이름</th>
                <th className="w-1/3 p-2">설명</th>
                <th className="p-2">좌표</th>
                <th className="w-24 p-2">버전</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.pages
                .flatMap((page) => page.items)
                .map((row) => (
                  <tr key={row.coordinate} className={selected?.coordinate === row.coordinate ? 'bg-accent' : ''}>
                    <td className="truncate p-2">
                      <button
                        type="button"
                        disabled={pending}
                        aria-pressed={selected?.coordinate === row.coordinate}
                        className="w-full truncate text-left font-medium"
                        onClick={() => setSelected(row)}
                      >
                        {row.title}
                      </button>
                    </td>
                    <td className="truncate p-2" title={row.description}>
                      {row.description}
                    </td>
                    <td className="truncate p-2" title={row.coordinate}>
                      {row.coordinate}
                    </td>
                    <td className="p-2">{row.version}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {query.isPending ? (
          <p role="status">예제를 불러오는 중…</p>
        ) : query.isError ? (
          <p role="alert">
            목록을 불러오지 못했습니다. <button onClick={() => void query.refetch()}>다시 시도</button>
          </p>
        ) : !query.data?.pages[0]?.items.length ? (
          <p>조건에 맞는 예제가 없습니다.</p>
        ) : null}
        <footer className="flex justify-end gap-2">
          {query.hasNextPage ? (
            <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              더 보기
            </Button>
          ) : null}
          <Button variant="outline" disabled={pending} onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={!selected || pending}
            onClick={async () => {
              if (!selected) return
              setPending(true)
              try {
                onApply(await catalogApi.getExperiment(selected))
              } catch (error) {
                toast.error(String(error))
              } finally {
                setPending(false)
              }
            }}
          >
            적용
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
