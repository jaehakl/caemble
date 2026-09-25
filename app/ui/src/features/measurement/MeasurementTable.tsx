import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getListRequest } from '@/api'
import { Button } from '@/components/ui/button'
import { usePrivateQueryScope } from '@/features/auth/use-auth'
import { measurementsQueryOptions } from './queryOptions'

export function MeasurementTable({
  experimentId,
  active,
  dataReadable,
  selectedId,
  loading,
  onSelect,
}: {
  experimentId: number | null
  active: boolean
  dataReadable: boolean
  selectedId: number | null
  loading: boolean
  onSelect: (id: number) => void
}) {
  const queryScope = usePrivateQueryScope()
  const [pagination, setPagination] = useState({ experimentId, queryScope, page: 0 })
  const page = pagination.experimentId === experimentId && pagination.queryScope === queryScope ? pagination.page : 0
  if (pagination.experimentId !== experimentId || pagination.queryScope !== queryScope) {
    setPagination({ experimentId, queryScope, page: 0 })
  }
  const query = useQuery({
    ...measurementsQueryOptions(queryScope, experimentId, {
      ...getListRequest('visible'),
      filter: { experiment_id: [experimentId, experimentId] },
      sort: [
        ['created_at', 'desc'],
        ['id', 'desc'],
      ],
      limit: 20,
      offset: page * 20,
    }),
    enabled: active && dataReadable && experimentId !== null,
  })
  const total = query.data?.total ?? 0
  const lastPage = Math.max(0, Math.ceil(total / 20) - 1)
  useEffect(() => {
    if (query.isSuccess && !query.isFetching && page > lastPage) {
      setPagination({ experimentId, queryScope, page: lastPage })
    }
  }, [experimentId, queryScope, page, lastPage, query.isSuccess, query.isFetching])

  return (
    <section aria-label="Measurement 목록" className="flex h-full min-h-0 flex-col gap-2 p-2">
      {experimentId === null ? (
        <p className="text-xs text-muted-foreground">먼저 저장된 Experiment를 불러오세요.</p>
      ) : !dataReadable ? (
        <p className="text-xs text-muted-foreground">Measurement를 보려면 로그인하세요.</p>
      ) : query.isPending ? (
        <p role="status" className="text-xs">
          불러오는 중…
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-2 text-xs">
          <p>목록을 불러오지 못했습니다.</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            다시 시도
          </Button>
        </div>
      ) : (
        <>
          {loading ? (
            <p role="status" className="text-xs text-muted-foreground">
              Measurement를 적용하는 중…
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-background">
                <tr>
                  <th className="p-2">ID</th>
                  <th className="p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((row) => (
                  <tr
                    key={row.id}
                    aria-selected={row.id === selectedId}
                    className="cursor-pointer border-t hover:bg-muted aria-selected:bg-accent"
                    onClick={() => onSelect(row.id)}
                  >
                    <td className="p-2">
                      <button
                        type="button"
                        className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Measurement #${row.id} ${row.recorded_at ? 'Recorded' : 'Prepared'}`}
                        aria-current={row.id === selectedId ? 'true' : undefined}
                        onClick={(event) => {
                          event.stopPropagation()
                          onSelect(row.id)
                        }}
                      >
                        #{row.id}
                      </button>
                    </td>
                    <td className="p-2">{row.recorded_at ? 'Recorded' : 'Prepared'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!query.data.items.length ? (
              <p className="p-2 text-xs text-muted-foreground">Measurement가 없습니다.</p>
            ) : null}
          </div>
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-1 text-xs">
            <span>{total.toLocaleString()}개</span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0 || query.isFetching}
                onClick={() => setPagination({ experimentId, queryScope, page: page - 1 })}
              >
                이전
              </Button>
              <span>
                {page + 1} / {lastPage + 1}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= lastPage || query.isFetching}
                onClick={() => setPagination({ experimentId, queryScope, page: page + 1 })}
              >
                다음
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  )
}
