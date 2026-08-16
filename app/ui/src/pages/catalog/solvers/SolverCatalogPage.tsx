import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cpu, FlaskConical, LoaderCircle } from 'lucide-react'
import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router'
import { catalogApi, catalogQueryKeys, type CatalogSolverDetail, type CatalogSolverListItem } from '@/api/catalog'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
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
  { accessorKey: 'description', header: '설명', cell: ({ row }) => <span className="line-clamp-2 text-muted-foreground">{row.original.description}</span> },
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
  const deferredQuery = useDeferredValue(query.trim())
  const selectedKey = controlledSelectedKey === undefined ? internalSelectedKey : controlledSelectedKey
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
  const rows = solvers.data?.items ?? []

  return (
    <CatalogPageLayout
      count={solvers.data?.total ?? 0}
      description="SQLite 카탈로그에서 조회한 활성 Solver 계약과 데이터 관계"
      embedded={embedded}
      title="Simulations & Analysis"
      filters={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Input className="max-w-md" aria-label="Solver 검색" onChange={(event) => setQuery(event.target.value)} placeholder="solver 이름 또는 설명" value={query} />
          <span className="flex items-center gap-2 text-sm text-muted-foreground"><Cpu className="size-4" />Catalog API · active versions</span>
        </div>
      }
      list={
        solvers.isPending ? (
          <CatalogLoading label="Solver 카탈로그를 조회하고 있습니다." />
        ) : solvers.isError ? (
          <CatalogError error={solvers.error} />
        ) : rows.length === 0 ? (
          <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><p className="font-medium">등록된 활성 Solver가 없습니다.</p><p className="mt-1 text-sm text-muted-foreground">검색 조건을 바꾸거나 카탈로그 배포 상태를 확인하세요.</p></div>
        ) : (
          <DataTable columns={columns} data={rows} getRowKey={solverKey} onRowClick={(row) => selectKey(solverKey(row))} selectedKey={selectedKey ?? undefined} />
        )
      }
      detail={<SolverDetail detail={detail.data} error={detail.error} pending={detail.isPending && !!selectedKey} />}
    />
  )
}

function solverKey(solver: Pick<CatalogSolverListItem, 'name' | 'version'>) {
  return `${solver.name}@${solver.version}`
}

function SolverDetail({ detail, error, pending }: { detail?: CatalogSolverDetail; error: Error | null; pending: boolean }) {
  if (pending) return <CatalogLoading label="Solver 관계 정보를 조회하고 있습니다." />
  if (error) return <CatalogError error={error} />
  if (!detail) {
    return <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><FlaskConical className="mb-3 size-8 text-muted-foreground" /><p className="font-medium">Solver를 선택하세요</p><p className="mt-1 text-sm text-muted-foreground">name과 version 단위의 계약 및 호환 관계를 표시합니다.</p></CardContent>
  }
  const descriptor = detail.descriptor
  const methods = Object.entries(descriptor.methods).flatMap(([category, entries]) => entries.map((method) => ({ category, method })))
  return (
    <>
      <CardHeader>
        <div className="mb-2 flex items-center justify-between"><Badge>{detail.version}</Badge><FlaskConical className="size-5 text-primary" /></div>
        <CardTitle className="font-mono text-lg">{detail.name}</CardTitle>
        <CardDescription>{detail.description}</CardDescription>
        <p className="font-mono text-[10px] break-all text-muted-foreground">Contract {detail.contractDigest}</p>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="parameters">
          <TabsList className="grid h-auto w-full grid-cols-2 sm:grid-cols-4">
            <TabsTrigger value="parameters">Parameters</TabsTrigger><TabsTrigger value="methods">Methods</TabsTrigger><TabsTrigger value="materials">Materials</TabsTrigger><TabsTrigger value="artifacts">Artifacts</TabsTrigger>
          </TabsList>
          <TabsContent className="space-y-3" value="parameters">
            {Object.entries(descriptor.parameters).length ? Object.entries(descriptor.parameters).map(([name, parameter]) => (
              <ContractCard description={parameter.description} key={name} title={name} values={parameter.data} />
            )) : <EmptyRelation label="global parameter" />}
          </TabsContent>
          <TabsContent className="space-y-3" value="methods">
            {methods.map(({ category, method }) => (
              <div className="rounded-lg border p-3" key={`${category}:${method.methodId}`}>
                <div className="flex items-center justify-between gap-2"><code className="text-xs font-semibold text-orange-700">{method.methodId}</code><Badge>{category}</Badge></div>
                <p className="mt-1 text-xs text-muted-foreground">{method.description}</p>
                <p className="mt-2 text-[11px] text-muted-foreground">Target · {method.target.source}.{method.target.kind} · {method.minimumOccurrences}..{method.maximumOccurrences} calls</p>
                {Object.entries(method.parameters).map(([name, parameter]) => <ContractCard className="mt-2" description={parameter.description} key={name} title={name} values={parameter.data} />)}
                {'artifactType' in method ? <p className="mt-2 rounded bg-muted p-2 text-[11px]">Produces <code>{method.artifactType}</code></p> : null}
              </div>
            ))}
          </TabsContent>
          <TabsContent className="space-y-3" value="materials">
            {descriptor.materials.length ? descriptor.materials.map((material) => (
              <div className="rounded-lg border p-3" key={material.role}>
                <code className="text-xs font-semibold text-orange-700">{material.role}</code><p className="mt-1 text-xs text-muted-foreground">{material.description}</p><p className="mt-2 text-[11px] text-muted-foreground">Required by {material.target.category}.{material.target.methodId}</p>
                <div className="mt-2 flex flex-wrap gap-1">{Object.keys(material.properties).map((key) => <Link key={key} to={`/docs?section=materials&item=${encodeURIComponent(key)}`}><Badge className="font-mono font-normal hover:bg-orange-100">{key}</Badge></Link>)}</div>
              </div>
            )) : <EmptyRelation label="material requirement" />}
          </TabsContent>
          <TabsContent className="space-y-4" value="artifacts">
            <ArtifactRelations title="Produces" items={detail.producesArtifacts} />
            <ArtifactRelations title="Consumes" items={detail.consumesArtifacts} />
            {Object.entries(descriptor.inputPorts).map(([name, port]) => (
              <div className="rounded-lg border p-3" key={name}><code className="text-xs font-semibold text-orange-700">{name}</code><p className="mt-1 text-xs text-muted-foreground">{port.description}</p><p className="mt-2 text-[11px]">Accepts {port.artifactTypes.join(', ')} · {port.minimumOccurrences}..{port.maximumOccurrences}</p></div>
            ))}
          </TabsContent>
        </Tabs>
      </CardContent>
    </>
  )
}

function ContractCard({ className = '', description, title, values }: { className?: string; description: string; title: string; values: Readonly<Record<string, unknown>> }) {
  return <div className={`rounded-lg border p-3 ${className}`}><code className="text-xs font-semibold text-orange-700">{title}</code><p className="mt-1 text-xs text-muted-foreground">{description}</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(values).filter(([, value]) => typeof value !== 'object').map(([key, value]) => <Badge className="font-mono font-normal" key={key}>{key}: {String(value)}</Badge>)}</div></div>
}

function ArtifactRelations({ items, title }: { items: CatalogSolverDetail['producesArtifacts'] | CatalogSolverDetail['consumesArtifacts']; title: string }) {
  return <div><p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p><div className="space-y-2">{items.length ? items.map((item, index) => {
    const peers = 'consumers' in item ? item.consumers.map((peer) => ({ ...peer, label: peer.inputPort })) : item.producers.map((peer) => ({ ...peer, label: peer.methodId }))
    return <div className="rounded-lg border p-3 text-xs" key={index}><p><code className="font-semibold text-orange-700">{item.artifactType}</code> · {'methodId' in item ? item.methodId : item.inputPort}</p><div className="mt-2 flex flex-wrap gap-1">{peers.map((peer) => <Link key={`${peer.solverName}@${peer.solverVersion}:${peer.label}`} to={`/docs?section=solvers&item=${encodeURIComponent(`${peer.solverName}@${peer.solverVersion}`)}`}><Badge className="font-mono font-normal hover:bg-orange-100">{peer.solverName}@{peer.solverVersion} · {peer.label}</Badge></Link>)}</div></div>
  }) : <p className="text-sm text-muted-foreground">관계가 없습니다.</p>}</div></div>
}

function EmptyRelation({ label }: { label: string }) { return <p className="py-8 text-center text-sm text-muted-foreground">등록된 {label}가 없습니다.</p> }
function CatalogLoading({ label }: { label: string }) { return <div className="flex min-h-60 items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircle className="animate-spin" />{label}</div> }
function CatalogError({ error }: { error: unknown }) { return <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center"><p className="font-medium text-destructive">Catalog API를 사용할 수 없습니다.</p><p className="mt-2 max-w-xl text-sm text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p></div> }
