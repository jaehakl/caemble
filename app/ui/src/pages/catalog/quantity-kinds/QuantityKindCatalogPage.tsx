import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Gauge, LoaderCircle, RefreshCw } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  catalogApi,
  catalogQueryKeys,
  type CatalogQuantityKind,
  type CatalogQuantityKindDetail,
} from '@/api/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const columns: ColumnDef<CatalogQuantityKind, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => <code className="text-xs font-semibold text-orange-700">{row.original.name}</code>,
  },
  { accessorKey: 'domain', header: 'Domain', cell: ({ row }) => <Badge>{row.original.domain}</Badge> },
  {
    accessorKey: 'tensorOrder',
    header: 'Order',
    cell: ({ row }) => <span className="tabular-nums">{row.original.tensorOrder}</span>,
  },
  {
    id: 'unit',
    header: 'Units',
    cell: ({ row }) => (
      <span className="line-clamp-1 text-xs text-muted-foreground">
        {row.original.applicableUnits.slice(0, 4).join(', ')}
      </span>
    ),
  },
]

export function QuantityCatalog({
  embedded = false,
  onSelectedKeyChange,
  selectedKey,
}: {
  embedded?: boolean
  onSelectedKeyChange?: (key: string) => void
  selectedKey?: string | null
} = {}) {
  const [internalSelectedName, setInternalSelectedName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [unit, setUnit] = useState('')
  const [domain, setDomain] = useState('')
  const [tensorOrder, setTensorOrder] = useState('all')
  const deferredQuery = useDeferredValue(query)
  const deferredUnit = useDeferredValue(unit)
  const selectedName = selectedKey === undefined ? internalSelectedName : selectedKey
  const selectName = onSelectedKeyChange ?? setInternalSelectedName
  const listQuery = {
    q: deferredQuery.trim(),
    unit: deferredUnit.trim(),
    domain: domain.trim(),
    tensorOrder: tensorOrder === 'all' ? undefined : Number(tensorOrder),
    limit: 100,
  }
  const quantities = useInfiniteQuery({
    queryKey: catalogQueryKeys.quantityKinds(listQuery),
    queryFn: ({ pageParam }) => catalogApi.listQuantityKinds({ ...listQuery, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
  const detail = useQuery({
    queryKey: catalogQueryKeys.quantityKind(selectedName ?? ''),
    queryFn: () => catalogApi.getQuantityKind(selectedName!),
    enabled: Boolean(selectedName),
    retry: false,
  })
  const rows = useMemo(() => quantities.data?.pages.flatMap((page) => page.items) ?? [], [quantities.data])
  const total = quantities.data?.pages[0]?.total ?? 0

  return (
    <CatalogPageLayout
      count={total}
      description="SQLite 카탈로그에서 조회한 표준 물리량, 단위 및 Solver 사용 관계"
      embedded={embedded}
      title="Physical Quantity Kinds"
      filters={
        <>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[1fr_1fr_180px_130px]">
            <Input
              aria-label="Quantity Kind 검색"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="이름 또는 설명 검색"
              value={query}
            />
            <Input
              aria-label="Unit 검색"
              onChange={(event) => setUnit(event.target.value)}
              placeholder="UCUM unit 검색"
              value={unit}
            />
            <Input
              aria-label="Quantity Kind domain"
              onChange={(event) => setDomain(event.target.value)}
              placeholder="domain 필터"
              value={domain}
            />
            <Select onValueChange={setTensorOrder} value={tensorOrder}>
              <SelectTrigger aria-label="Tensor order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 order</SelectItem>
                {[0, 1, 2, 3, 4].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    Order {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            서버 검색 결과 {total.toLocaleString()}개 · 현재 {rows.length.toLocaleString()}개 표시
          </p>
        </>
      }
      list={
        quantities.isPending ? (
          <CatalogLoading label="Quantity Kind를 조회하고 있습니다." />
        ) : quantities.isError ? (
          <CatalogError error={quantities.error} onRetry={() => void quantities.refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={rows}
              getRowKey={(row) => row.name}
              onRowClick={(row) => selectName(row.name)}
              selectedKey={selectedName ?? undefined}
            />
            {quantities.hasNextPage ? (
              <div className="border-t p-3 text-center">
                <Button
                  disabled={quantities.isFetchingNextPage}
                  size="sm"
                  variant="outline"
                  onClick={() => void quantities.fetchNextPage()}
                >
                  {quantities.isFetchingNextPage ? <LoaderCircle className="animate-spin" /> : null}
                  더 불러오기
                </Button>
              </div>
            ) : null}
          </>
        )
      }
      detail={<QuantityDetail detail={detail.data} error={detail.error} pending={detail.isPending && !!selectedName} />}
    />
  )
}

function QuantityDetail({
  detail,
  error,
  pending,
}: {
  detail?: CatalogQuantityKindDetail
  error: Error | null
  pending: boolean
}) {
  if (pending) return <CatalogLoading label="관계 정보를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} />
  if (!detail) {
    return (
      <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
        <Gauge className="mb-3 size-8 text-muted-foreground" />
        <p className="font-medium">Quantity Kind를 선택하세요</p>
        <p className="mt-1 text-sm text-muted-foreground">단위와 Material·Solver 관계를 확인합니다.</p>
      </CardContent>
    )
  }
  return (
    <>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between">
          <Badge>{detail.domain}</Badge>
          <Gauge className="size-5 text-primary" />
        </div>
        <CardTitle className="font-mono text-lg break-all">{detail.name}</CardTitle>
        <CardDescription>{detail.description || '카탈로그에 설명이 없습니다.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Tensor order</p>
            <p className="mt-1 font-semibold">{detail.tensorOrder}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Component shape</p>
            <code className="mt-1 block">[{Array.from({ length: detail.tensorOrder }, () => '3').join(', ')}]</code>
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Applicable UCUM units</p>
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
            {detail.applicableUnits.map((value) => (
              <Badge className="font-mono font-normal" key={value}>{value}</Badge>
            ))}
          </div>
        </div>
        <RelationList title="Material parameters">
          {detail.materialParameters.map((parameter) => (
            <Link
              className="block rounded border p-2 font-mono text-xs text-orange-700 hover:bg-orange-50"
              key={parameter.key}
              to={`/docs?section=materials&item=${encodeURIComponent(parameter.key)}`}
            >
              {parameter.key}<span className="mt-1 block font-sans text-muted-foreground">{parameter.labelKo}</span>
            </Link>
          ))}
        </RelationList>
        <RelationList title="Solver usages">
          {detail.solverUsages.map((usage, index) => (
            <Link
              className="block rounded border p-2 text-xs hover:bg-orange-50"
              key={`${usage.solverName}@${usage.solverVersion}:${usage.path}:${index}`}
              to={`/docs?section=solvers&item=${encodeURIComponent(`${usage.solverName}@${usage.solverVersion}`)}`}
            >
              <code className="font-semibold text-orange-700">{usage.solverName}@{usage.solverVersion}</code>
              <span className="mt-1 block text-muted-foreground">{usage.context} · {usage.path}{usage.unit ? ` · ${usage.unit}` : ''}</span>
            </Link>
          ))}
        </RelationList>
      </CardContent>
    </>
  )
}

function RelationList({ children, title }: { children: React.ReactNode; title: string }) {
  return <div><p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p><div className="space-y-2">{children}</div></div>
}

function CatalogLoading({ label }: { label: string }) {
  return <div className="flex min-h-60 items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" />{label}</div>
}

function CatalogError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><p className="font-medium text-destructive">Catalog API를 사용할 수 없습니다.</p><p className="mt-2 max-w-xl text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>{onRetry ? <Button className="mt-4" size="sm" variant="outline" onClick={onRetry}><RefreshCw />다시 시도</Button> : null}</div>
}
