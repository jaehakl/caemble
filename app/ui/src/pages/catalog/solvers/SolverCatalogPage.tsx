import { useQuery } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { Cpu, FlaskConical } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CaeManifestError, fetchCaeSolverManifests } from '@/features/cae/manifests'
import type { KernelDescriptor } from '@/lib/cad/simulation'

const columns: ColumnDef<KernelDescriptor, unknown>[] = [
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

export function SolverCatalogPage() {
  const navigate = useNavigate()
  const { name, version } = useParams()
  const manifests = useQuery({
    queryKey: ['cae', 'solver-manifests'],
    queryFn: fetchCaeSolverManifests,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  const solvers = manifests.data?.map((manifest) => manifest.descriptor) ?? []
  const selected = solvers.find((solver) => solver.name === name && (!version || solver.version === version))
  const methods = selected
    ? Object.entries(selected.methods).flatMap(([category, entries]) => entries.map((method) => ({ category, method })))
    : []
  return (
    <CatalogPageLayout
      count={solvers.length}
      description="Solver 별 구동 및 데이터 입출력 API 일람"
      title="Simulations & Analysis"
      filters={
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <Cpu className="size-4" />
            app/slaves에서 build-time 로드
          </span>
        </div>
      }
      list={
        manifests.isPending ? (
          <div className="flex min-h-60 items-center justify-center p-8 text-sm text-muted-foreground">
            CAE solver manifest를 조회하고 있습니다.
          </div>
        ) : manifests.isError ? (
          <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <p className="font-medium text-destructive">
              {manifests.error instanceof CaeManifestError
                ? '잘못된 solver manifest입니다.'
                : 'Solver manifest를 읽을 수 없습니다.'}
            </p>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {manifests.error instanceof Error ? manifests.error.message : String(manifests.error)}
            </p>
          </div>
        ) : solvers.length === 0 ? (
          <div className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <p className="font-medium">등록된 solver가 없습니다.</p>
            <p className="mt-1 text-sm text-muted-foreground">app/slaves에 solver manifest가 없습니다.</p>
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={solvers}
            getRowKey={(row) => `${row.name}@${row.version}`}
            onRowClick={(row) =>
              navigate(`/catalog/solvers/${encodeURIComponent(row.name)}/${encodeURIComponent(row.version)}`)
            }
            selectedKey={selected ? `${selected.name}@${selected.version}` : undefined}
          />
        )
      }
      detail={
        selected ? (
          <>
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <Badge>{selected.version}</Badge>
                <FlaskConical className="size-5 text-primary" />
              </div>
              <CardTitle className="font-mono text-lg">{selected.name}</CardTitle>
              <CardDescription>{selected.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="parameters">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="parameters">Parameters</TabsTrigger>
                  <TabsTrigger value="methods">Methods</TabsTrigger>
                  <TabsTrigger value="materials">Materials</TabsTrigger>
                </TabsList>
                <TabsContent className="space-y-3" value="parameters">
                  {Object.entries(selected.parameters).map(([parameterName, parameter]) => (
                    <div className="rounded-lg border p-3" key={parameterName}>
                      <code className="text-xs font-semibold text-orange-700">{parameterName}</code>
                      <p className="mt-1 text-xs text-muted-foreground">{parameter.description}</p>
                      <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-[11px]">
                        {JSON.stringify(parameter.data, null, 2)}
                      </pre>
                    </div>
                  ))}
                </TabsContent>
                <TabsContent className="space-y-3" value="methods">
                  {methods.map(({ category, method }) => (
                    <div className="rounded-lg border p-3" key={method.methodId}>
                      <div className="flex items-center justify-between gap-2">
                        <code className="text-xs font-semibold text-orange-700">{method.methodId}</code>
                        <Badge>{category}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{method.description}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Target · {method.target.source}.{method.target.kind}
                      </p>
                      {'artifactType' in method ? (
                        <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-[11px]">
                          Artifact {method.artifactType}
                          {'\n'}
                          {JSON.stringify(method.data, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </TabsContent>
                <TabsContent className="space-y-3" value="materials">
                  {selected.materials.map((material) => (
                    <div className="rounded-lg border p-3" key={material.role}>
                      <code className="text-xs font-semibold text-orange-700">{material.role}</code>
                      <p className="mt-1 text-xs text-muted-foreground">{material.description}</p>
                      <pre className="mt-2 overflow-auto rounded bg-muted p-2 text-[11px]">
                        {JSON.stringify(material.properties, null, 2)}
                      </pre>
                    </div>
                  ))}
                </TabsContent>
              </Tabs>
            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <FlaskConical className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">Solver를 선택하세요</p>
            <p className="mt-1 text-sm text-muted-foreground">정확한 name과 version 단위로 계약을 표시합니다.</p>
            {name ? (
              <p className="mt-3 text-xs text-destructive">
                등록되지 않은 Solver: {name}
                {version ? `@${version}` : ''}
              </p>
            ) : null}
          </CardContent>
        )
      }
    />
  )
}

export const Component = SolverCatalogPage
