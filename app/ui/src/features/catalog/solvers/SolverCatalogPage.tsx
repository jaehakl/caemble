import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cpu, FlaskConical } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useDebouncedValue } from '@/shared/useDebouncedValue'
import { CopyButton } from '@/components/CopyButton'
import { Link } from 'react-router'
import { type CatalogExperimentListItem, type CatalogSolverDetail, type CatalogSolverListItem } from '@/api/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CatalogError, CatalogLoading } from '../CatalogAsyncState'
import {
  catalogExperimentQueryOptions,
  catalogExperimentsQueryOptions,
  catalogSolverQueryOptions,
  catalogSolversInfiniteQueryOptions,
  catalogExperimentsInfiniteQueryOptions,
} from '../queryOptions'

const columns: ColumnDef<CatalogSolverListItem, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Solver',
    cell: ({ row }) => <code className="font-semibold text-primary">{row.original.name}</code>,
  },
  { accessorKey: 'version', header: 'Version', cell: ({ row }) => <Badge>{row.original.version}</Badge> },
  {
    accessorKey: 'description',
    header: '설명',
    cell: ({ row }) => <span className="line-clamp-2 text-muted-foreground">{row.original.description}</span>,
  },
]

export function PhysicsCatalog({
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
  const separator = selectedKey?.lastIndexOf('@') ?? -1
  const selectedName = separator > 0 ? selectedKey!.slice(0, separator) : ''
  const selectedVersion = separator > 0 ? selectedKey!.slice(separator + 1) : ''
  const listQuery = { q: deferredQuery, limit: 100 }
  const solvers = useInfiniteQuery({
    ...catalogSolversInfiniteQueryOptions(listQuery),
    retry: false,
  })
  const detail = useQuery({
    ...catalogSolverQueryOptions(selectedName, selectedVersion, Boolean(selectedName && selectedVersion)),
    retry: false,
  })
  const relatedExperiments = useQuery(
    catalogExperimentsQueryOptions(
      { solverName: selectedName, solverVersion: selectedVersion, limit: 100 },
      Boolean(selectedName && selectedVersion),
    ),
  )
  const rows = useMemo(() => solvers.data?.pages.flatMap((page) => page.items) ?? [], [solvers.data])

  return (
    <CatalogPageLayout
      count={solvers.data?.pages[0]?.total ?? 0}
      description="Solver의 입력 규격, 재료 요구 사항과 결과 연결 관계를 확인합니다."
      embedded={embedded}
      title="Simulations & Analysis"
      filters={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Input
            className="max-w-md"
            aria-label="Solver 검색"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="solver 이름 또는 설명"
            value={query}
          />
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Cpu className="size-4" />
            활성 Solver 버전
          </span>
        </div>
      }
      list={
        solvers.isPending ? (
          <CatalogLoading label="Solver 카탈로그를 조회하고 있습니다." />
        ) : solvers.isError ? (
          <CatalogError error={solvers.error} onRetry={() => void solvers.refetch()} />
        ) : rows.length === 0 ? (
          <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <p className="font-medium">등록된 활성 Solver가 없습니다.</p>
            <p className="mt-1 text-sm text-muted-foreground">검색 조건을 바꾸거나 카탈로그 배포 상태를 확인하세요.</p>
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              data={rows}
              getRowKey={solverKey}
              onRowClick={(row) => selectKey(solverKey(row))}
              selectedKey={selectedKey ?? undefined}
            />
            {solvers.hasNextPage ? (
              <Button
                className="m-3"
                variant="outline"
                disabled={solvers.isFetchingNextPage}
                onClick={() => void solvers.fetchNextPage()}
              >
                더 불러오기
              </Button>
            ) : null}
          </>
        )
      }
      detail={
        <SolverDetail
          detail={detail.data}
          error={
            selectedKey && (!selectedName || !selectedVersion)
              ? new Error('Solver 이름과 버전이 포함된 항목을 선택하세요.')
              : detail.error
          }
          pending={detail.isPending && Boolean(selectedName && selectedVersion)}
          onRetry={() => void detail.refetch()}
          relatedExperiments={relatedExperiments.data?.items ?? []}
          onSelectExperiment={(coordinate) => {
            selectKey(`experiment:${coordinate}`)
          }}
        />
      }
    />
  )
}

export function ExampleExperimentCatalog({
  embedded,
  onSelect,
  onSelectSolver,
  selectedKey,
}: {
  embedded: boolean
  onSelect?: (key: string) => void
  onSelectSolver: (name: string, version: string) => void
  selectedKey: string | null
}) {
  const [query, setQuery] = useState('')
  const [internalKey, setInternalKey] = useState<string | null>(null)
  const [activeFile, setActiveFile] = useState('experiment.tsx')
  const activeKey = selectedKey ?? internalKey
  const select = onSelect ?? setInternalKey
  const settledQuery = useDebouncedValue(query.trim())
  const listQuery = useInfiniteQuery(catalogExperimentsInfiniteQueryOptions({ q: settledQuery, limit: 100 }))
  const listedExperiments = useMemo(() => listQuery.data?.pages.flatMap((page) => page.items) ?? [], [listQuery.data])
  const exactIdentity = listedExperiments.find((item) => item.coordinate === activeKey)
  const keyMatches = listedExperiments.filter((item) => item.key === activeKey)
  const activeIdentity = exactIdentity ?? (keyMatches.length === 1 ? keyMatches[0] : activeKey)
  const detailQuery = useQuery(catalogExperimentQueryOptions(activeIdentity ?? '', activeKey !== null))
  const sourceFiles = detailQuery.data ? Object.keys(detailQuery.data.sourceBundle.files) : []
  const selectedFile = sourceFiles.includes(activeFile) ? activeFile : (sourceFiles[0] ?? '')

  return (
    <CatalogPageLayout
      count={listQuery.data?.pages[0]?.total ?? 0}
      description="완성된 Experiment의 구성과 소스를 살펴보세요."
      embedded={embedded}
      title="Examples"
      filters={
        <Input
          aria-label="Example 검색"
          placeholder="key, 제목, 설명 검색"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      }
      list={
        listQuery.isLoading ? (
          <CatalogLoading label="Example을 조회하고 있습니다." />
        ) : listQuery.isError ? (
          <CatalogError error={listQuery.error} onRetry={() => void listQuery.refetch()} />
        ) : (
          <>
            <ul className="divide-y">
              {listedExperiments.map((item) => (
                <li key={item.coordinate}>
                  <button
                    className={`grid w-full gap-1 p-3 text-left hover:bg-muted/60 ${activeKey === item.coordinate || (keyMatches.length === 1 && activeKey === item.key) ? 'bg-primary/10' : ''}`}
                    type="button"
                    onClick={() => select(item.coordinate)}
                  >
                    <span className="font-medium">{item.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{item.coordinate}</span>
                    <span className="line-clamp-2 text-sm text-muted-foreground">{item.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            {!listedExperiments.length ? (
              <p className="p-6 text-sm text-muted-foreground">검색 결과가 없습니다.</p>
            ) : null}
            {listQuery.hasNextPage ? (
              <Button
                className="m-3"
                variant="outline"
                disabled={listQuery.isFetchingNextPage}
                onClick={() => void listQuery.fetchNextPage()}
              >
                더 불러오기
              </Button>
            ) : null}
          </>
        )
      }
      detail={
        detailQuery.isLoading ? (
          <CatalogLoading label="Example detail을 조회하고 있습니다." />
        ) : detailQuery.isError ? (
          <CatalogError error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
        ) : detailQuery.data ? (
          <>
            <CardHeader>
              <CardTitle>{detailQuery.data.title}</CardTitle>
              <CardDescription>{detailQuery.data.description}</CardDescription>
              <p className="font-mono text-xs text-muted-foreground">{detailQuery.data.coordinate}</p>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <h3 className="text-sm font-semibold">Related Solvers</h3>
                <div className="mt-2 flex flex-wrap gap-1">
                  {detailQuery.data.relatedSolvers.map((solver) => (
                    <Button
                      key={`${solver.name}@${solver.version}`}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => onSelectSolver(solver.name, solver.version)}
                    >
                      {solver.name}@{solver.version}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">Source bundle · 읽기 전용</h3>
                  <CopyButton text={detailQuery.data.sourceBundle.files[selectedFile] ?? ''} label="파일 내용 복사" />
                </div>
                <Tabs value={selectedFile} onValueChange={setActiveFile}>
                  <TabsList className="flex h-auto max-w-full justify-start overflow-x-auto">
                    {sourceFiles.map((file) => (
                      <TabsTrigger key={file} value={file}>
                        {file}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {sourceFiles.map((file) => (
                    <TabsContent key={file} value={file}>
                      <pre className="max-h-[34rem] overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-5 text-neutral-100">
                        <code>{detailQuery.data.sourceBundle.files[file]}</code>
                      </pre>
                    </TabsContent>
                  ))}
                </Tabs>
              </div>
            </CardContent>
          </>
        ) : (
          <CardContent className="grid min-h-60 place-items-center text-sm text-muted-foreground">
            Example을 선택하세요.
          </CardContent>
        )
      }
    />
  )
}

function solverKey(solver: Pick<CatalogSolverListItem, 'name' | 'version'>) {
  return `${solver.name}@${solver.version}`
}

function SolverDetail({
  detail,
  error,
  onSelectExperiment,
  pending,
  onRetry,
  relatedExperiments,
}: {
  detail?: CatalogSolverDetail
  error: Error | null
  onSelectExperiment: (coordinate: string) => void
  pending: boolean
  onRetry?: () => void
  relatedExperiments: readonly CatalogExperimentListItem[]
}) {
  if (pending) return <CatalogLoading label="Solver 관계 정보를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} onRetry={onRetry} />
  if (!detail) {
    return (
      <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
        <FlaskConical className="mb-3 size-8 text-muted-foreground" />
        <p className="font-medium">Solver를 선택하세요</p>
        <p className="mt-1 text-sm text-muted-foreground">name과 version 단위의 계약 및 호환 관계를 표시합니다.</p>
      </CardContent>
    )
  }
  const descriptor = detail.descriptor
  const methods = Object.entries(descriptor.methods).flatMap(([category, entries]) =>
    entries.map((method) => ({ category, method })),
  )
  return (
    <>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between">
          <Badge>{detail.version}</Badge>
          <FlaskConical className="size-5 text-primary" />
        </div>
        <CardTitle className="font-mono text-lg">{detail.name}</CardTitle>
        <CardDescription>{detail.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-5">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Examples</p>
          <div className="flex flex-wrap gap-1">
            {relatedExperiments.length ? (
              relatedExperiments.map((experiment) => (
                <Button
                  key={experiment.coordinate}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => onSelectExperiment(experiment.coordinate)}
                >
                  {experiment.title}
                </Button>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">등록된 관계가 없습니다.</span>
            )}
          </div>
        </div>
        <Tabs defaultValue="parameters">
          <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="parameters">Parameters</TabsTrigger>
            <TabsTrigger value="methods">Methods</TabsTrigger>
            <TabsTrigger value="materials">Materials</TabsTrigger>
            <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          </TabsList>
          <TabsContent className="space-y-3" value="parameters">
            {Object.entries(descriptor.parameters).length ? (
              Object.entries(descriptor.parameters).map(([name, parameter]) => (
                <ContractCard description={parameter.description} key={name} title={name} values={parameter.data} />
              ))
            ) : (
              <EmptyRelation label="global parameter" />
            )}
          </TabsContent>
          <TabsContent className="space-y-3" value="methods">
            {methods.map(({ category, method }) => (
              <div className="rounded-lg border p-3" key={`${category}:${method.methodId}`}>
                <div className="flex items-center justify-between gap-2">
                  <code className="text-xs font-semibold text-primary">{method.methodId}</code>
                  <Badge>{category}</Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{method.description}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Target · {method.target.source}.{method.target.kind} · {method.minimumOccurrences}..
                  {method.maximumOccurrences} calls
                </p>
                {Object.entries(method.parameters).map(([name, parameter]) => (
                  <ContractCard
                    className="mt-2"
                    description={parameter.description}
                    key={name}
                    title={name}
                    values={parameter.data}
                  />
                ))}
                {'artifactType' in method ? (
                  <p className="mt-2 rounded bg-muted p-2 text-[11px]">
                    Produces <code>{method.artifactType}</code>
                  </p>
                ) : null}
              </div>
            ))}
          </TabsContent>
          <TabsContent className="space-y-3" value="materials">
            {descriptor.materials.length ? (
              descriptor.materials.map((material) => (
                <div className="rounded-lg border p-3" key={material.role}>
                  <code className="text-xs font-semibold text-primary">{material.role}</code>
                  <p className="mt-1 text-xs text-muted-foreground">{material.description}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {material.target.category === 'geometry'
                      ? `${material.target.source}.geometry`
                      : `${material.target.category}.${material.target.methodId}`}
                    의 각 Material에 적용
                  </p>
                  <div className="mt-3 space-y-3">
                    {material.modelGroups.map((group) => (
                      <div key={group.key}>
                        <p className="mb-1 text-xs font-medium">
                          {group.key} · {group.required ? '필수' : '선택'} · 하나 선택
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {group.oneOf.map((key) => (
                            <Link key={key} to={`/?help=materials&item=${encodeURIComponent(key)}`}>
                              <Badge className="font-mono font-normal hover:bg-primary/15">{key}</Badge>
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <EmptyRelation label="material requirement" />
            )}
          </TabsContent>
          <TabsContent className="space-y-4" value="artifacts">
            <ArtifactRelations title="Produces" items={detail.producesArtifacts} />
            <ArtifactRelations title="Consumes" items={detail.consumesArtifacts} />
            {Object.entries(descriptor.inputPorts).map(([name, port]) => (
              <div className="rounded-lg border p-3" key={name}>
                <code className="text-xs font-semibold text-primary">{name}</code>
                <p className="mt-1 text-xs text-muted-foreground">{port.description}</p>
                <p className="mt-2 text-[11px]">
                  Accepts {port.artifactTypes.join(', ')} · {port.minimumOccurrences}..{port.maximumOccurrences}
                </p>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
    </>
  )
}

function ContractCard({
  className = '',
  description,
  title,
  values,
}: {
  className?: string
  description: string
  title: string
  values: Readonly<Record<string, unknown>>
}) {
  return (
    <div className={`rounded-lg border p-3 ${className}`}>
      <code className="text-xs font-semibold text-primary">{title}</code>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {Object.entries(values)
          .filter(([, value]) => typeof value !== 'object')
          .map(([key, value]) => (
            <Badge className="font-mono font-normal" key={key}>
              {key}: {String(value)}
            </Badge>
          ))}
      </div>
    </div>
  )
}

function ArtifactRelations({
  items,
  title,
}: {
  items: CatalogSolverDetail['producesArtifacts'] | CatalogSolverDetail['consumesArtifacts']
  title: string
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      <div className="space-y-2">
        {items.length ? (
          items.map((item, index) => {
            const peers =
              'consumers' in item
                ? item.consumers.map((peer) => ({ ...peer, label: peer.inputPort }))
                : item.producers.map((peer) => ({ ...peer, label: peer.methodId }))
            return (
              <div className="rounded-lg border p-3 text-xs" key={index}>
                <p>
                  <code className="font-semibold text-primary">{item.artifactType}</code> ·{' '}
                  {'methodId' in item ? item.methodId : item.inputPort}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {peers.map((peer) => (
                    <Link
                      key={`${peer.solverName}@${peer.solverVersion}:${peer.label}`}
                      to={`/?help=solvers&item=${encodeURIComponent(`${peer.solverName}@${peer.solverVersion}`)}`}
                    >
                      <Badge className="font-mono font-normal hover:bg-primary/15">
                        {peer.solverName}@{peer.solverVersion} · {peer.label}
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            )
          })
        ) : (
          <p className="text-sm text-muted-foreground">관계가 없습니다.</p>
        )}
      </div>
    </div>
  )
}

function EmptyRelation({ label }: { label: string }) {
  return <p className="py-8 text-center text-sm text-muted-foreground">등록된 {label}가 없습니다.</p>
}
