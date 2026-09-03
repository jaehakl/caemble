import type { ColumnDef } from '@tanstack/react-table'
import { Check, Clipboard, Code2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cadAuthoringContract, cadElementCatalog } from '@/lib/cad/catalog'

type CadCatalogEntry = (typeof cadElementCatalog)[number]

const columns: ColumnDef<CadCatalogEntry, unknown>[] = [
  {
    accessorKey: 'authoringName',
    header: 'Tag',
    cell: ({ row }) => <code className="font-semibold text-orange-700">{row.original.authoringName}</code>,
  },
  { accessorKey: 'category', header: '종류', cell: ({ row }) => <Badge>{row.original.category}</Badge> },
  {
    accessorKey: 'summary',
    header: '설명',
    cell: ({ row }) => <span className="line-clamp-2 text-muted-foreground">{row.original.summary}</span>,
  },
]

export function GeometryCatalog({
  embedded = false,
  onSelectedKeyChange,
  selectedKey,
}: {
  embedded?: boolean
  onSelectedKeyChange?: (key: string) => void
  selectedKey?: string | null
} = {}) {
  const [internalSelectedTag, setInternalSelectedTag] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | 'operation' | 'primitive'>('all')
  const selectedTag = selectedKey === undefined ? internalSelectedTag : selectedKey
  const selectTag = onSelectedKeyChange ?? setInternalSelectedTag
  const selected = cadElementCatalog.find((entry) => entry.tag === selectedTag)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return cadElementCatalog.filter(
      (entry) =>
        (category === 'all' || entry.category === category) &&
        (!needle ||
          `${entry.authoringName} ${entry.tag} ${entry.summary} ${entry.syntax} ${entry.keywords.join(' ')} ${entry.properties
            .map(({ description, name, type }) => `${name} ${type} ${description}`)
            .join(' ')}`
            .toLowerCase()
            .includes(needle)),
    )
  }, [category, query])

  return (
    <CatalogPageLayout
      count={cadElementCatalog.length}
      description="CAD primitive와 operation의 공식 문법·예제"
      embedded={embedded}
      title="Primitives & Operations"
      filters={
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Geometry 검색"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="tag, 문법, 설명 검색"
            value={query}
          />
          <Select onValueChange={(value) => setCategory(value as typeof category)} value={category}>
            <SelectTrigger aria-label="CAD 종류" className="sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 종류</SelectItem>
              <SelectItem value="primitive">Primitive</SelectItem>
              <SelectItem value="operation">Operation</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
      list={
        <DataTable
          columns={columns}
          data={filtered}
          getRowKey={(row) => row.tag}
          onRowClick={(row) => selectTag(row.tag)}
          selectedKey={selected?.tag}
        />
      }
      detail={
        selected ? (
          <>
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <Badge>{selected.category}</Badge>
                <Code2 className="size-5 text-primary" />
              </div>
              <CardTitle className="font-mono text-xl">&lt;{selected.authoringName} /&gt;</CardTitle>
              <CardDescription>{selected.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="mb-2 text-xs font-medium text-muted-foreground">기본 문법</p>
              <div className="relative rounded-lg border bg-neutral-950 p-4 pr-12 text-sm text-neutral-100">
                <code className="break-all">{selected.syntax}</code>
                <Button
                  aria-label="문법 복사"
                  className="absolute top-2 right-2 text-neutral-300 hover:bg-neutral-800 hover:text-white"
                  size="icon"
                  variant="ghost"
                  onClick={() =>
                    navigator.clipboard.writeText(selected.syntax).then(() => toast.success('문법을 복사했습니다.'))
                  }
                >
                  <Clipboard />
                </Button>
              </div>

              <div className="mt-6 rounded-lg border bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-medium text-slate-950">
                  {selected.standardTransforms ? '공통 identity와 transform' : 'Transform wrapper 계약'}
                </p>
                {selected.standardTransforms ? (
                  <p className="mt-1 leading-6">
                    이 element는 선택적 <code>{cadAuthoringContract.identity.name}</code>와 canonical{' '}
                    <code>position</code>, <code>rotation</code>, <code>scale</code>을 사용합니다. 적용 순서는{' '}
                    <code>{cadAuthoringContract.transforms.applicationOrder.join(' → ')}</code>입니다.{' '}
                    {cadAuthoringContract.transforms.rotationConvention} Nested path 예시는{' '}
                    <code>{cadAuthoringContract.identity.pathExample}</code>입니다.
                  </p>
                ) : (
                  <p className="mt-1 leading-6">
                    선택적 <code>{cadAuthoringContract.identity.name}</code>와 아래 전용 prop만 사용합니다. Direct{' '}
                    <code>position</code>, <code>rotation</code>, <code>scale</code>은 child에 두고, wrapper의 중첩
                    순서로 transform 합성을 명시하세요.
                  </p>
                )}
                <a
                  className="mt-2 inline-block font-medium text-orange-700 underline underline-offset-4"
                  href="/docs?section=reference#cad-reference-geometry-transforms"
                >
                  좌표계·identity·migration 계약 보기
                </a>
              </div>

              <div className="mt-6">
                <h3 className="text-sm font-semibold">Properties</h3>
                <div className="mt-2 overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600">
                      <tr>
                        <th className="border-b px-3 py-2 font-medium">이름</th>
                        <th className="border-b px-3 py-2 font-medium">타입</th>
                        <th className="border-b px-3 py-2 font-medium">필수</th>
                        <th className="border-b px-3 py-2 font-medium">기본값</th>
                        <th className="border-b px-3 py-2 font-medium">설명·제약</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        {
                          name: cadAuthoringContract.identity.name,
                          type: cadAuthoringContract.identity.type,
                          required: cadAuthoringContract.identity.required,
                          description: cadAuthoringContract.identity.description,
                        },
                        ...(selected.standardTransforms ? cadAuthoringContract.transforms.canonicalProperties : []),
                        ...selected.properties,
                      ].map((property) => (
                        <tr className="align-top last:[&>td]:border-b-0" key={property.name}>
                          <td className="border-b px-3 py-2 font-mono font-medium">{property.name}</td>
                          <td className="border-b px-3 py-2 font-mono text-xs">{property.type}</td>
                          <td className="border-b px-3 py-2">{property.required ? '필수' : '선택'}</td>
                          <td className="border-b px-3 py-2 font-mono text-xs">
                            {'default' in property && property.default !== undefined ? property.default : '—'}
                          </td>
                          <td className="border-b px-3 py-2 leading-6 text-muted-foreground">{property.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
                <div className="rounded-lg border p-4">
                  <dt className="font-semibold">Origin</dt>
                  <dd className="mt-1 leading-6 text-muted-foreground">{selected.origin}</dd>
                </div>
                <div className="rounded-lg border p-4">
                  <dt className="font-semibold">Children</dt>
                  <dd className="mt-1 leading-6 text-muted-foreground">
                    <span className="font-mono text-foreground">{selected.children.count}</span> —{' '}
                    {selected.children.description}
                  </dd>
                </div>
              </dl>

              <div className="mt-6">
                <h3 className="text-sm font-semibold">Surfaces</h3>
                {selected.surfaces.length ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
                    {selected.surfaces.map((surface) => (
                      <li key={surface.index}>
                        <span className="font-mono text-foreground">surface/{surface.index}</span> — {surface.label}.{' '}
                        {surface.description}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">고정된 surface 계약이 없습니다.</p>
                )}
              </div>

              <div className="mt-6">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">공식 예제</h3>
                  <Button
                    aria-label="예제 복사"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      navigator.clipboard.writeText(selected.example).then(() => toast.success('예제를 복사했습니다.'))
                    }
                  >
                    <Clipboard />
                    복사
                  </Button>
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg bg-neutral-950 p-4 text-xs leading-5 text-neutral-100">
                  <code>{selected.example}</code>
                </pre>
              </div>

            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <Check className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">요소를 선택하세요</p>
            <p className="mt-1 text-sm text-muted-foreground">
              목록의 행을 누르면 prop, 기본값, origin, surface와 공식 예제를 볼 수 있습니다.
            </p>
          </CardContent>
        )
      }
    />
  )
}
