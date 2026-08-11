import type { ColumnDef } from '@tanstack/react-table'
import { Gauge } from 'lucide-react'
import { useMemo, useState } from 'react'
import { CatalogPageLayout } from '@/components/CatalogPageLayout'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { quantityKindData } from '@/lib/quantitykind'

type QuantityKindRow = Readonly<{
  applicableUnits: readonly string[]
  description?: string
  domain: string
  name: string
  tensorOrder: number
}>

const rows = Object.entries(quantityKindData).map(([name, entry]) => ({ name, ...entry })) as readonly QuantityKindRow[]
const domains = [...new Set(rows.map((row) => row.domain))].sort()
const columns: ColumnDef<QuantityKindRow, unknown>[] = [
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

export function QuantityCatalog() {
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [unit, setUnit] = useState('')
  const [domain, setDomain] = useState('all')
  const [tensorOrder, setTensorOrder] = useState('all')
  const selected = rows.find((row) => row.name === selectedName)
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const unitNeedle = unit.trim().toLowerCase()
    return rows.filter(
      (row) =>
        (domain === 'all' || row.domain === domain) &&
        (tensorOrder === 'all' || row.tensorOrder === Number(tensorOrder)) &&
        (!needle || `${row.name} ${row.description ?? ''}`.toLowerCase().includes(needle)) &&
        (!unitNeedle || row.applicableUnits.some((value) => value.toLowerCase().includes(unitNeedle))),
    )
  }, [domain, query, tensorOrder, unit])

  return (
    <CatalogPageLayout
      count={rows.length}
      description="다양한 물리 계산에서 사용될 수 있는 표준화된 물리량 및 단위"
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
            <Select onValueChange={setDomain} value={domain}>
              <SelectTrigger aria-label="Quantity Kind domain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 domain</SelectItem>
                {domains.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select onValueChange={setTensorOrder} value={tensorOrder}>
              <SelectTrigger aria-label="Tensor order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체 order</SelectItem>
                {[0, 1, 2, 3].map((value) => (
                  <SelectItem key={value} value={String(value)}>
                    Order {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            검색 결과 {filtered.length.toLocaleString()}개 · 성능을 위해 처음 250개를 표시합니다.
          </p>
        </>
      }
      list={
        <DataTable
          columns={columns}
          data={filtered.slice(0, 250)}
          getRowKey={(row) => row.name}
          onRowClick={(row) => setSelectedName(row.name)}
          selectedKey={selected?.name}
        />
      }
      detail={
        selected ? (
          <>
            <CardHeader>
              <div className="mb-2 flex items-center justify-between">
                <Badge>{selected.domain}</Badge>
                <Gauge className="size-5 text-primary" />
              </div>
              <CardTitle className="font-mono text-lg break-all">{selected.name}</CardTitle>
              <CardDescription>{selected.description || '원본 카탈로그에 설명이 없습니다.'}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Tensor order</p>
                  <p className="mt-1 font-semibold">{selected.tensorOrder}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Component shape</p>
                  <code className="mt-1 block">
                    [{Array.from({ length: selected.tensorOrder }, () => '3').join(', ')}]
                  </code>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  Applicable UCUM units · {selected.applicableUnits.length}
                </p>
                <div className="flex max-h-52 flex-wrap gap-1.5 overflow-auto">
                  {selected.applicableUnits.map((value) => (
                    <Badge className="font-mono font-normal" key={value}>
                      {value}
                    </Badge>
                  ))}
                </div>
              </div>
            </CardContent>
          </>
        ) : (
          <CardContent className="flex min-h-60 flex-col items-center justify-center p-8 text-center">
            <Gauge className="mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">Quantity Kind를 선택하세요</p>
            <p className="mt-1 text-sm text-muted-foreground">설명, tensor order, 적용 가능한 unit을 확인합니다.</p>
          </CardContent>
        )
      }
    />
  )
}
