import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers3, LoaderCircle } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  catalogApi,
  catalogQueryKeys,
  type CatalogMaterialModel,
  type CatalogMaterialParameter,
  type CatalogMaterialParameterDetail,
} from '@/api/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

type MaterialRow = Readonly<{
  domain: string
  key: string
  kind: 'model' | 'parameter'
  label: string
  quantityKind: string
}>

const columns: ColumnDef<MaterialRow, unknown>[] = [
  {
    accessorKey: 'key',
    header: 'Key',
    cell: ({ row }) => <code className="text-xs font-semibold text-orange-700">{row.original.key}</code>,
  },
  { accessorKey: 'label', header: '이름' },
  {
    accessorKey: 'quantityKind',
    header: 'Quantity Kind',
    cell: ({ row }) => <code className="line-clamp-1 text-xs text-muted-foreground">{row.original.quantityKind}</code>,
  },
]

export function MaterialCatalog({
  embedded = false,
  onSelectedKeyChange,
  selectedKey: controlledSelectedKey,
}: {
  embedded?: boolean
  onSelectedKeyChange?: (key: string) => void
  selectedKey?: string | null
} = {}) {
  const [internalSelectedKey, setInternalSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [quantityKind, setQuantityKind] = useState('')
  const [domain, setDomain] = useState('')
  const deferredQuery = useDeferredValue(query.trim())
  const selectedKey = controlledSelectedKey === undefined ? internalSelectedKey : controlledSelectedKey
  const selectKey = onSelectedKeyChange ?? setInternalSelectedKey
  const listQuery = { q: deferredQuery, domain: domain.trim(), quantityKind: quantityKind.trim(), limit: 100 }
  const parameters = useInfiniteQuery({
    queryKey: catalogQueryKeys.materialParameters(listQuery),
    queryFn: ({ pageParam }) => catalogApi.listMaterialParameters({ ...listQuery, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
  const models = useQuery({
    queryKey: catalogQueryKeys.materialModels({ q: deferredQuery, limit: 100 }),
    queryFn: () => catalogApi.listMaterialModels({ q: deferredQuery, limit: 100 }),
    retry: false,
  })
  const isModel = selectedKey?.startsWith('model.') ?? false
  const parameterDetail = useQuery({
    queryKey: catalogQueryKeys.materialParameter(selectedKey ?? ''),
    queryFn: () => catalogApi.getMaterialParameter(selectedKey!),
    enabled: Boolean(selectedKey && !isModel),
    retry: false,
  })
  const modelDetail = useQuery({
    queryKey: ['catalog', 'material-model', selectedKey ?? ''],
    queryFn: () => catalogApi.getMaterialModel(selectedKey!),
    enabled: Boolean(selectedKey && isModel),
    retry: false,
  })
  const rows = useMemo(() => {
    const quantityNeedle = quantityKind.trim().toLowerCase()
    const parameterRows = (parameters.data?.pages.flatMap((page) => page.items) ?? []).map(parameterRow)
    const modelRows = (models.data?.items ?? []).map(modelRow).filter((entry) => !quantityNeedle || entry.quantityKind.toLowerCase().includes(quantityNeedle))
    return [...parameterRows, ...modelRows]
  }, [models.data, parameters.data, quantityKind])
  const total = (parameters.data?.pages[0]?.total ?? 0) + (models.data?.total ?? 0)
  const listError = parameters.error ?? models.error

  return (
    <CatalogPageLayout
      count={total}
      description="표준 Material parameter와 QuantityKind·Solver 요구 관계"
      embedded={embedded}
      title="Material Parameters"
      filters={
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_180px]">
          <Input aria-label="Material 검색" onChange={(event) => setQuery(event.target.value)} placeholder="key 또는 한국어 이름" value={query} />
          <Input aria-label="Quantity Kind 필터" onChange={(event) => setQuantityKind(event.target.value)} placeholder="Quantity Kind 필터" value={quantityKind} />
          <Input aria-label="Material domain" onChange={(event) => setDomain(event.target.value)} placeholder="domain 필터" value={domain} />
        </div>
      }
      list={
        parameters.isPending || models.isPending ? (
          <CatalogLoading label="Material 카탈로그를 조회하고 있습니다." />
        ) : listError ? (
          <CatalogError error={listError} />
        ) : (
          <>
            <DataTable columns={columns} data={rows} getRowKey={(row) => row.key} onRowClick={(row) => selectKey(row.key)} selectedKey={selectedKey ?? undefined} />
            {parameters.hasNextPage ? (
              <div className="border-t p-3 text-center">
                <Button disabled={parameters.isFetchingNextPage} size="sm" variant="outline" onClick={() => void parameters.fetchNextPage()}>
                  {parameters.isFetchingNextPage ? <LoaderCircle className="animate-spin" /> : null}더 불러오기
                </Button>
              </div>
            ) : null}
          </>
        )
      }
      detail={
        isModel ? (
          <MaterialModelDetail detail={modelDetail.data} error={modelDetail.error} pending={modelDetail.isPending && !!selectedKey} />
        ) : (
          <MaterialParameterDetail detail={parameterDetail.data} error={parameterDetail.error} pending={parameterDetail.isPending && !!selectedKey} />
        )
      }
    />
  )
}

function parameterRow(entry: CatalogMaterialParameter): MaterialRow {
  return { domain: entry.domain, key: entry.key, kind: 'parameter', label: entry.labelKo, quantityKind: entry.quantityKind }
}

function modelRow(entry: CatalogMaterialModel): MaterialRow {
  return { domain: 'model', key: entry.key, kind: 'model', label: entry.labelKo, quantityKind: `${entry.input.quantityKind} → ${entry.output.quantityKind}` }
}

function MaterialParameterDetail({ detail, error, pending }: { detail?: CatalogMaterialParameterDetail; error: Error | null; pending: boolean }) {
  if (pending) return <CatalogLoading label="관계 정보를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} />
  if (!detail) return <EmptyDetail />
  return (
    <>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between"><Badge>parameter</Badge><Layers3 className="size-5 text-primary" /></div>
        <CardTitle className="font-mono text-lg break-all">{detail.key}</CardTitle>
        <CardDescription>{detail.labelKo}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div><p className="text-xs font-medium text-muted-foreground">Domain</p><p className="mt-1">{detail.domain}</p></div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">Quantity Kind</p>
          <Link className="mt-1 block rounded bg-muted p-2 font-mono text-xs break-all text-orange-700 hover:bg-orange-50" to={`/docs?section=quantity-kinds&item=${encodeURIComponent(detail.quantityKind)}`}>{detail.quantityKind}</Link>
        </div>
        <div><p className="text-xs font-medium text-muted-foreground">Special qualifiers</p><p className="mt-1 text-muted-foreground">{detail.specialQualifiers.length ? detail.specialQualifiers.join(', ') : '없음'}</p></div>
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground">Required by solvers</p>
          <div className="space-y-2">
            {detail.solverRequirements.length ? detail.solverRequirements.map((requirement) => (
              <Link className="block rounded border p-2 text-xs hover:bg-orange-50" key={`${requirement.solverName}@${requirement.solverVersion}:${requirement.role}:${requirement.methodId}`} to={`/docs?section=solvers&item=${encodeURIComponent(`${requirement.solverName}@${requirement.solverVersion}`)}`}>
                <code className="font-semibold text-orange-700">{requirement.solverName}@{requirement.solverVersion}</code>
                <span className="mt-1 block text-muted-foreground">{requirement.role} · {requirement.methodCategory}.{requirement.methodId}</span>
                <span className="mt-1 block">{requirement.description}</span>
              </Link>
            )) : <p className="text-muted-foreground">현재 활성 Solver가 요구하지 않습니다.</p>}
          </div>
        </div>
      </CardContent>
    </>
  )
}

function MaterialModelDetail({ detail, error, pending }: { detail?: CatalogMaterialModel; error: Error | null; pending: boolean }) {
  if (pending) return <CatalogLoading label="Material model을 조회하고 있습니다." />
  if (error) return <CatalogError error={error} />
  if (!detail) return <EmptyDetail />
  return (
    <>
      <CardHeader><div className="mb-2 flex items-center justify-between"><Badge>model</Badge><Layers3 className="size-5 text-primary" /></div><CardTitle className="font-mono text-lg break-all">{detail.key}</CardTitle><CardDescription>{detail.labelKo}</CardDescription></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {[['Input', detail.input.name, detail.input.quantityKind], ['Output', detail.output.name, detail.output.quantityKind]].map(([label, name, kind]) => (
          <div key={label}><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-1">{name}</p>{kind ? <Link className="mt-1 block font-mono text-xs text-orange-700" to={`/docs?section=quantity-kinds&item=${encodeURIComponent(kind)}`}>{kind}</Link> : null}</div>
        ))}
        <div className="grid grid-cols-2 gap-3"><div><p className="text-xs text-muted-foreground">Minimum samples</p><p className="mt-1 font-medium">{detail.minimumSamples}</p></div><div><p className="text-xs text-muted-foreground">Shared basis</p><p className="mt-1 font-medium">{detail.sharedBasis ? 'Yes' : 'No'}</p></div></div>
      </CardContent>
    </>
  )
}

function EmptyDetail() {
  return <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><Layers3 className="mb-3 size-8 text-muted-foreground" /><p className="font-medium">Material 항목을 선택하세요</p><p className="mt-1 text-sm text-muted-foreground">QuantityKind 및 Solver 요구 관계를 확인합니다.</p></CardContent>
}

function CatalogLoading({ label }: { label: string }) {
  return <div className="flex min-h-60 items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" />{label}</div>
}

function CatalogError({ error }: { error: unknown }) {
  return <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><p className="font-medium text-destructive">Catalog API를 사용할 수 없습니다.</p><p className="mt-2 max-w-xl text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p></div>
}
