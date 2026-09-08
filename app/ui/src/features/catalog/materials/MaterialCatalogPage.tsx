import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Layers3, LoaderCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDebouncedValue } from '@/shared/useDebouncedValue'
import { Link } from 'react-router'
import type { CatalogMaterialModel, ModelParameterSchema } from '@/contracts/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { CatalogError, CatalogLoading } from '../CatalogAsyncState'
import { catalogMaterialModelQueryOptions, catalogMaterialModelsInfiniteQueryOptions } from '../queryOptions'

const columns: ColumnDef<CatalogMaterialModel, unknown>[] = [
  {
    accessorKey: 'key',
    header: 'Model',
    cell: ({ row }) => <code className="text-xs font-semibold text-primary">{row.original.key}</code>,
  },
  { accessorKey: 'labelKo', header: '이름' },
  {
    accessorKey: 'description',
    header: '설명',
    cell: ({ row }) => <span className="line-clamp-2 text-xs text-muted-foreground">{row.original.description}</span>,
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
  const deferredQuery = useDebouncedValue(query.trim())
  const selectedKey = controlledSelectedKey === undefined ? internalSelectedKey : controlledSelectedKey
  const selectKey = onSelectedKeyChange ?? setInternalSelectedKey
  const models = useInfiniteQuery(catalogMaterialModelsInfiniteQueryOptions({ q: deferredQuery, limit: 100 }))
  const detail = useQuery({
    ...catalogMaterialModelQueryOptions(selectedKey ?? '', Boolean(selectedKey)),
    retry: false,
  })
  const rows = useMemo(() => models.data?.pages.flatMap((page) => page.items) ?? [], [models.data])
  return (
    <CatalogPageLayout
      count={models.data?.pages[0]?.total ?? 0}
      description="모델의 정의와 입력 규격을 조회합니다. 계수는 Experiment의 material.tsx에서 직접 정의합니다."
      embedded={embedded}
      title="Model Catalog"
      filters={
        <Input
          aria-label="Model 검색"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="모델 ID 또는 이름"
          value={query}
        />
      }
      list={
        models.isPending ? (
          <CatalogLoading label="Model Catalog를 조회하고 있습니다." />
        ) : models.isError ? (
          <CatalogError error={models.error} onRetry={() => void models.refetch()} />
        ) : (
          <>
            <DataTable
              columns={columns}
              data={rows}
              getRowKey={(row) => row.key}
              onRowClick={(row) => selectKey(row.key)}
              selectedKey={selectedKey ?? undefined}
            />
            {models.hasNextPage ? (
              <div className="border-t p-3 text-center">
                <Button
                  disabled={models.isFetchingNextPage}
                  size="sm"
                  variant="outline"
                  onClick={() => void models.fetchNextPage()}
                >
                  {models.isFetchingNextPage ? <LoaderCircle className="animate-spin" /> : null}더 불러오기
                </Button>
              </div>
            ) : null}
          </>
        )
      }
      detail={
        <MaterialModelDetail
          detail={detail.data}
          error={detail.error}
          pending={detail.isPending && !!selectedKey}
          onRetry={() => void detail.refetch()}
        />
      }
    />
  )
}

export function MaterialModelDetail({
  detail,
  error,
  pending,
  onRetry,
}: {
  detail?: CatalogMaterialModel
  error: Error | null
  pending: boolean
  onRetry?: () => void
}) {
  if (pending) return <CatalogLoading label="Material Model 정의를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} onRetry={onRetry} />
  if (!detail)
    return (
      <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
        <Layers3 className="mb-3 size-8 text-muted-foreground" />
        <p className="font-medium">Material Model을 선택하세요</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Material Model 식, 파라미터 구조와 지원 Solver를 확인합니다.
        </p>
      </CardContent>
    )
  return (
    <>
      <CardHeader>
        <Badge className="w-fit">Material Model</Badge>
        <CardTitle className="font-mono text-lg break-all">{detail.key}</CardTitle>
        <CardDescription>{detail.labelKo}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <p>{detail.description}</p>
        <div>
          <p className="mb-2 font-medium">Material Model 식</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">{detail.equation}</pre>
        </div>
        <div>
          <p className="mb-2 font-medium">해석 관례</p>
          <p className="whitespace-pre-wrap text-muted-foreground">{detail.conventions}</p>
        </div>
        <div>
          <p className="mb-2 font-medium">Material Model parameters</p>
          <ModelParameterTree schema={detail.parameterSchema} path="parameters" required />
        </div>
        <div>
          <p className="mb-2 font-medium">지원 Solver</p>
          <div className="space-y-2">
            {detail.solverRequirements?.length ? (
              detail.solverRequirements.map((requirement, index) => (
                <Link
                  className="block rounded border p-2 text-xs hover:bg-primary/10"
                  key={`${requirement.solverName}@${requirement.solverVersion}:${requirement.role}:${index}`}
                  to={`/?help=solvers&item=${encodeURIComponent(`${requirement.solverName}@${requirement.solverVersion}`)}`}
                >
                  <code className="font-semibold text-primary">
                    {requirement.solverName}@{requirement.solverVersion}
                  </code>
                  <span className="mt-1 block text-muted-foreground">
                    {requirement.role} · {requirement.groupKey} · {requirement.required ? '필수 그룹' : '선택 그룹'}
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-muted-foreground">현재 활성 Solver의 지원 선언이 없습니다.</p>
            )}
          </div>
        </div>
      </CardContent>
    </>
  )
}

function ModelParameterTree({
  schema,
  path,
  required,
}: {
  schema: ModelParameterSchema
  path: string
  required: boolean
}) {
  return (
    <div className="space-y-2 border-l pl-3">
      <p>
        <code className="text-xs font-semibold">{path}</code>{' '}
        <span className="text-xs text-muted-foreground">
          {schema.kind} · {required ? '필수' : '선택'}
        </span>
      </p>
      {schema.description ? <p className="text-xs text-muted-foreground">{schema.description}</p> : null}
      {schema.omission ? <p className="text-xs">생략 시: {schema.omission}</p> : null}
      {schema.kind === 'value' ? (
        <div className="space-y-1 text-xs">
          <p>
            {schema.dtype ?? 'float64'} · shape [{(schema.shape ?? []).join(', ')}]
            {schema.unit ? ` · ${schema.unit}` : ''}
          </p>
          {schema.quantityKind ? (
            <Link
              className="font-mono text-primary"
              to={`/?help=quantity-kinds&item=${encodeURIComponent(schema.quantityKind)}`}
            >
              {schema.quantityKind}
            </Link>
          ) : null}
          {schema.values ? <p>허용 값: {schema.values.join(', ')}</p> : null}
          {schema.minimum !== undefined ? (
            <p>
              최솟값: {schema.exclusiveMinimum ? '>' : '≥'} {schema.minimum}
            </p>
          ) : null}
          {schema.maximum !== undefined ? (
            <p>
              최댓값: {schema.exclusiveMaximum ? '<' : '≤'} {schema.maximum}
            </p>
          ) : null}
        </div>
      ) : schema.kind === 'object' ? (
        Object.entries(schema.fields).map(([name, field]) => (
          <ModelParameterTree
            key={name}
            schema={field}
            path={`${path}.${name}`}
            required={schema.required?.includes(name) ?? false}
          />
        ))
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            항 개수: {schema.minimumLength ?? 0}–{schema.maximumLength ?? '제한 없음'}
            {schema.increasingBy ? ` · ${schema.increasingBy} 오름차순` : ''}
          </p>
          <ModelParameterTree schema={schema.items} path={`${path}[]`} required />
        </>
      )}
    </div>
  )
}
