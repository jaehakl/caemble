import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cpu, FlaskConical, LoaderCircle } from 'lucide-react'
import { useDeferredValue, useEffect, useState } from 'react'
import { Link } from 'react-router'
import {
  catalogApi,
  catalogQueryKeys,
  type CatalogExperimentListItem,
  type CatalogSolverDetail,
  type CatalogSolverListItem,
} from '@/api/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const columns: ColumnDef<CatalogSolverListItem, unknown>[] = [
  {
    accessorKey: 'name',
    header: 'Solver',
    cell: ({ row }) => <code className="font-semibold text-orange-700">{row.original.name}</code>,
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
  const [catalogTab, setCatalogTab] = useState<'solvers' | 'experiments'>(
    controlledSelectedKey?.startsWith('experiment:') ? 'experiments' : 'solvers',
  )
  useEffect(() => {
    if (controlledSelectedKey?.startsWith('experiment:')) setCatalogTab('experiments')
    else if (controlledSelectedKey) setCatalogTab('solvers')
  }, [controlledSelectedKey])
  const deferredQuery = useDeferredValue(query.trim())
  const selectedKey =
    controlledSelectedKey === undefined
      ? internalSelectedKey
      : controlledSelectedKey?.startsWith('experiment:')
        ? null
        : controlledSelectedKey
  const selectKey = onSelectedKeyChange ?? setInternalSelectedKey
  const separator = selectedKey?.lastIndexOf('@') ?? -1
  const selectedName = separator > 0 ? selectedKey!.slice(0, separator) : ''
  const selectedVersion = separator > 0 ? selectedKey!.slice(separator + 1) : ''
  const listQuery = { q: deferredQuery, limit: 100 }
  const solvers = useQuery({
    queryKey: catalogQueryKeys.solvers(listQuery),
    queryFn: () => catalogApi.listSolvers(listQuery),
    retry: false,
  })
  const detail = useQuery({
    queryKey: catalogQueryKeys.solver(selectedName, selectedVersion),
    queryFn: () => catalogApi.getSolver(selectedName, selectedVersion),
    enabled: Boolean(selectedName && selectedVersion),
    retry: false,
  })
  const relatedExperiments = useQuery({
    queryKey: catalogQueryKeys.experiments({ solverName: selectedName, solverVersion: selectedVersion, limit: 100 }),
    queryFn: () => catalogApi.listExperiments({ solverName: selectedName, solverVersion: selectedVersion, limit: 100 }),
    enabled: Boolean(selectedName && selectedVersion),
  })
  const rows = solvers.data?.items ?? []

  return (
    <Tabs value={catalogTab} onValueChange={(value) => setCatalogTab(value as typeof catalogTab)}>
      <div className="border-b px-4 pt-4 sm:px-6">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="solvers">Solvers</TabsTrigger>
          <TabsTrigger value="experiments">Examples</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent className="mt-0" value="solvers">
        <CatalogPageLayout
          count={solvers.data?.total ?? 0}
          description="SQLite 카탈로그에서 조회한 활성 Solver 계약과 데이터 관계"
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
                Catalog API · active versions
              </span>
            </div>
          }
          list={
            solvers.isPending ? (
              <CatalogLoading label="Solver 카탈로그를 조회하고 있습니다." />
            ) : solvers.isError ? (
              <CatalogError error={solvers.error} />
            ) : rows.length === 0 ? (
              <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
                <p className="font-medium">등록된 활성 Solver가 없습니다.</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  검색 조건을 바꾸거나 카탈로그 배포 상태를 확인하세요.
                </p>
              </div>
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                getRowKey={solverKey}
                onRowClick={(row) => selectKey(solverKey(row))}
                selectedKey={selectedKey ?? undefined}
              />
            )
          }
          detail={
            <SolverDetail
              detail={detail.data}
              error={detail.error}
              pending={detail.isPending && !!selectedKey}
              relatedExperiments={relatedExperiments.data?.items ?? []}
              onSelectExperiment={(coordinate) => {
                setCatalogTab('experiments')
                onSelectedKeyChange?.(`experiment:${coordinate}`)
              }}
            />
          }
        />
      </TabsContent>
      <TabsContent className="mt-0" value="experiments">
        <ExampleExperimentCatalog
          embedded={embedded}
          selectedKey={
            controlledSelectedKey?.startsWith('experiment:') ? controlledSelectedKey.slice('experiment:'.length) : null
          }
          onSelect={(key) => onSelectedKeyChange?.(`experiment:${key}`)}
          onSelectSolver={(name, version) => {
            setCatalogTab('solvers')
            selectKey(`${name}@${version}`)
          }}
        />
      </TabsContent>
    </Tabs>
  )
}

function ExampleExperimentCatalog({
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
  const listQuery = useQuery({
    queryKey: catalogQueryKeys.experiments({ q: query.trim(), limit: 100 }),
    queryFn: () => catalogApi.listExperiments({ q: query.trim(), limit: 100 }),
  })
  const listedExperiments = listQuery.data?.items ?? []
  const exactIdentity = listedExperiments.find((item) => item.coordinate === activeKey)
  const keyMatches = listedExperiments.filter((item) => item.key === activeKey)
  const activeIdentity = exactIdentity ?? (keyMatches.length === 1 ? keyMatches[0] : activeKey)
  const detailQuery = useQuery({
    queryKey: catalogQueryKeys.experiment(activeIdentity ?? ''),
    queryFn: () => catalogApi.getExperiment(activeIdentity!),
    enabled: activeKey !== null,
  })
  const sourceFiles = detailQuery.data ? Object.keys(detailQuery.data.sourceBundle.files) : []
  const selectedFile = sourceFiles.includes(activeFile) ? activeFile : (sourceFiles[0] ?? '')

  return (
    <CatalogPageLayout
      count={listQuery.data?.total ?? 0}
      description="SQLite 카탈로그에서 제공하는 읽기 전용 Experiment bundle v6 예제"
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
          <CatalogError error={listQuery.error} />
        ) : (
          <ul className="divide-y">
            {listedExperiments.map((item) => (
              <li key={item.coordinate}>
                <button
                  className={`grid w-full gap-1 p-3 text-left hover:bg-muted/60 ${activeKey === item.coordinate || (keyMatches.length === 1 && activeKey === item.key) ? 'bg-orange-50' : ''}`}
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
        )
      }
      detail={
        detailQuery.isLoading ? (
          <CatalogLoading label="Example detail을 조회하고 있습니다." />
        ) : detailQuery.isError ? (
          <CatalogError error={detailQuery.error} />
        ) : detailQuery.data ? (
          <>
            <CardHeader>
              <div className="mb-2 flex flex-wrap gap-1">
                <Badge>CAD API v{detailQuery.data.cadApiVersion}</Badge>
                <Badge>bundle v{detailQuery.data.bundleFormatVersion}</Badge>
                <Badge>source v{detailQuery.data.sourceFormatVersion}</Badge>
              </div>
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
                <h3 className="text-sm font-semibold">Verification</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Tasks: {detailQuery.data.verification.kernelTasks.join(', ')} · RecordedData:{' '}
                  {detailQuery.data.verification.recordedData.join(', ')}
                </p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {detailQuery.data.verification.expectations.map((expectation) => (
                    <li key={expectation}>{expectation}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold">Source bundle</h3>
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
  relatedExperiments,
}: {
  detail?: CatalogSolverDetail
  error: Error | null
  onSelectExperiment: (coordinate: string) => void
  pending: boolean
  relatedExperiments: readonly CatalogExperimentListItem[]
}) {
  if (pending) return <CatalogLoading label="Solver 관계 정보를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} />
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
        <p className="font-mono text-[10px] break-all text-muted-foreground">Contract {detail.contractDigest}</p>
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
                  <code className="text-xs font-semibold text-orange-700">{method.methodId}</code>
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
                  <code className="text-xs font-semibold text-orange-700">{material.role}</code>
                  <p className="mt-1 text-xs text-muted-foreground">{material.description}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Required by {material.target.category}.{material.target.methodId}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {Object.keys(material.properties).map((key) => (
                      <Link key={key} to={`/docs?section=materials&item=${encodeURIComponent(key)}`}>
                        <Badge className="font-mono font-normal hover:bg-orange-100">{key}</Badge>
                      </Link>
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
                <code className="text-xs font-semibold text-orange-700">{name}</code>
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
      <code className="text-xs font-semibold text-orange-700">{title}</code>
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
                  <code className="font-semibold text-orange-700">{item.artifactType}</code> ·{' '}
                  {'methodId' in item ? item.methodId : item.inputPort}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {peers.map((peer) => (
                    <Link
                      key={`${peer.solverName}@${peer.solverVersion}:${peer.label}`}
                      to={`/docs?section=solvers&item=${encodeURIComponent(`${peer.solverName}@${peer.solverVersion}`)}`}
                    >
                      <Badge className="font-mono font-normal hover:bg-orange-100">
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
function CatalogLoading({ label }: { label: string }) {
  return (
    <div className="flex min-h-60 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
      <LoaderCircle className="animate-spin" />
      {label}
    </div>
  )
}
function CatalogError({ error }: { error: unknown }) {
  return (
    <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
      <p className="font-medium text-destructive">Catalog API를 사용할 수 없습니다.</p>
      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
    </div>
  )
}
