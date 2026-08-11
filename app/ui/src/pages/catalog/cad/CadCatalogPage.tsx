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
import { cadElementCatalog } from '@/lib/cad'

type CadCatalogEntry = (typeof cadElementCatalog)[number]

const columns: ColumnDef<CadCatalogEntry, unknown>[] = [
  {
    accessorKey: 'tag',
    header: 'Tag',
    cell: ({ row }) => <code className="font-semibold text-orange-700">{row.original.tag}</code>,
  },
  { accessorKey: 'category', header: '종류', cell: ({ row }) => <Badge>{row.original.category}</Badge> },
  {
    accessorKey: 'summary',
    header: '설명',
    cell: ({ row }) => <span className="line-clamp-2 text-muted-foreground">{row.original.summary}</span>,
  },
]

export function GeometryCatalog() {
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | 'operation' | 'primitive'>('all')
  const selected = cadElementCatalog.find((entry) => entry.tag === selectedTag)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return cadElementCatalog.filter(
      (entry) =>
        (category === 'all' || entry.category === category) &&
        (!needle || `${entry.tag} ${entry.summary} ${entry.syntax}`.toLowerCase().includes(needle)),
    )
  }, [category, query])

  return (
    <CatalogPageLayout
      count={cadElementCatalog.length}
      description="Code-to-CAD 문법 기본 요소"
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
          onRowClick={(row) => setSelectedTag(row.tag)}
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
              <CardTitle className="font-mono text-xl">&lt;{selected.tag} /&gt;</CardTitle>
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
            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <Check className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">요소를 선택하세요</p>
            <p className="mt-1 text-sm text-muted-foreground">목록의 행을 누르면 문법과 설명을 볼 수 있습니다.</p>
          </CardContent>
        )
      }
    />
  )
}
