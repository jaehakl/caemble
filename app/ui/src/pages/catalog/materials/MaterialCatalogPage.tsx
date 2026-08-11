import type { ColumnDef } from '@tanstack/react-table'
import { Layers3 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { materialModelData, materialParameterData, materialParameterDomains } from '@/lib/material'

type MaterialRow = Readonly<{
  domain: string
  key: string
  kind: 'model' | 'parameter'
  label: string
  quantityKind: string
  source: (typeof materialParameterData)[number] | (typeof materialModelData)[number]
}>

const rows: readonly MaterialRow[] = [
  ...materialParameterData.map((entry) => ({
    domain: entry.key.split('.')[0],
    key: entry.key,
    kind: 'parameter' as const,
    label: entry.label_ko,
    quantityKind: entry.quantity_kind,
    source: entry,
  })),
  ...materialModelData.map((entry) => ({
    domain: 'model',
    key: entry.key,
    kind: 'model' as const,
    label: entry.label_ko,
    quantityKind: `${entry.input.quantity_kind} → ${entry.output.quantity_kind}`,
    source: entry,
  })),
]

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

export function MaterialCatalog() {
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [quantityKind, setQuantityKind] = useState('')
  const [domain, setDomain] = useState('all')
  const selected = rows.find((row) => row.key === selectedKey)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const quantityNeedle = quantityKind.trim().toLowerCase()
    return rows.filter(
      (row) =>
        (domain === 'all' || row.domain === domain) &&
        (!needle || `${row.key} ${row.label}`.toLowerCase().includes(needle)) &&
        (!quantityNeedle || row.quantityKind.toLowerCase().includes(quantityNeedle)),
    )
  }, [domain, query, quantityKind])

  const parameter = selected?.kind === 'parameter' ? (selected.source as (typeof materialParameterData)[number]) : null
  const model = selected?.kind === 'model' ? (selected.source as (typeof materialModelData)[number]) : null
  return (
    <CatalogPageLayout
      count={rows.length}
      description="다양한 물리 계산에서 사용될 수 있는 표준화된 물성 파라미터"
      title="Material Parameters"
      filters={
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_180px]">
          <Input
            aria-label="Material 검색"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="key 또는 한국어 이름"
            value={query}
          />
          <Input
            aria-label="Quantity Kind 필터"
            onChange={(event) => setQuantityKind(event.target.value)}
            placeholder="Quantity Kind 필터"
            value={quantityKind}
          />
          <Select onValueChange={setDomain} value={domain}>
            <SelectTrigger aria-label="Material domain">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">전체 domain</SelectItem>
              {materialParameterDomains.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
              <SelectItem value="model">model relation</SelectItem>
            </SelectContent>
          </Select>
        </div>
      }
      list={
        <DataTable
          columns={columns}
          data={filtered}
          getRowKey={(row) => row.key}
          onRowClick={(row) => setSelectedKey(row.key)}
          selectedKey={selected?.key}
        />
      }
      detail={
        selected ? (
          <>
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <Badge>{selected.kind}</Badge>
                <Layers3 className="size-5 text-primary" />
              </div>
              <CardTitle className="font-mono text-lg break-all">{selected.key}</CardTitle>
              <CardDescription>{selected.label}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
              {parameter ? (
                <>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Domain</p>
                    <p className="mt-1">{selected.domain}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Quantity Kind</p>
                    <code className="mt-1 block rounded bg-muted p-2 text-xs break-all">{parameter.quantity_kind}</code>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Special qualifiers</p>
                    <p className="mt-1 text-muted-foreground">
                      {'special_qualifiers' in parameter && parameter.special_qualifiers?.length
                        ? parameter.special_qualifiers.join(', ')
                        : '없음'}
                    </p>
                  </div>
                </>
              ) : null}
              {model ? (
                <>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Input</p>
                    <code className="mt-1 block rounded bg-muted p-2 text-xs break-all">
                      {model.input.name} · {model.input.quantity_kind}
                    </code>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Output</p>
                    <code className="mt-1 block rounded bg-muted p-2 text-xs break-all">
                      {model.output.name} · {model.output.quantity_kind}
                    </code>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Minimum samples</p>
                      <p className="mt-1 font-medium">{model.minimum_samples}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Shared basis</p>
                      <p className="mt-1 font-medium">{model.shared_basis ? 'Yes' : 'No'}</p>
                    </div>
                  </div>
                </>
              ) : null}
            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <Layers3 className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">Material 항목을 선택하세요</p>
            <p className="mt-1 text-sm text-muted-foreground">
              parameter 또는 model relation의 계약을 확인할 수 있습니다.
            </p>
          </CardContent>
        )
      }
    />
  )
}
