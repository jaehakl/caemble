import { useQuery } from '@tanstack/react-query'
import { LoaderCircle, Search } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  catalogMaterialModelsQueryOptions,
  catalogMaterialParametersQueryOptions,
} from '@/features/catalog/queryOptions'

export type MaterialCatalogEntry = Readonly<{
  key: string
  kind: 'parameter' | 'model'
  label: string
  quantityKind: string
}>

export function MaterialCatalogPickerDialog({
  onOpenChange,
  onSelect,
  open,
}: {
  onOpenChange: (open: boolean) => void
  onSelect: (entry: MaterialCatalogEntry) => Promise<void>
  open: boolean
}) {
  const [query, setQuery] = useState('')
  const [selectionError, setSelectionError] = useState('')
  const [pendingKey, setPendingKey] = useState('')
  const request = { q: query.trim() || undefined, limit: 100 }
  const parametersQuery = useQuery(catalogMaterialParametersQueryOptions(request, open))
  const modelsQuery = useQuery(catalogMaterialModelsQueryOptions(request, open))
  const entries: readonly MaterialCatalogEntry[] = [
    ...(parametersQuery.data?.items ?? []).map((entry) => ({
      key: entry.key,
      kind: 'parameter' as const,
      label: entry.labelKo,
      quantityKind: entry.quantityKind,
    })),
    ...(modelsQuery.data?.items ?? []).map((entry) => ({
      key: entry.key,
      kind: 'model' as const,
      label: entry.labelKo,
      quantityKind: `${entry.input.quantityKind} → ${entry.output.quantityKind}`,
    })),
  ]
  const loading = parametersQuery.isPending || modelsQuery.isPending
  const failed = parametersQuery.isError || modelsQuery.isError

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Material parameter 탐색</DialogTitle>
          <DialogDescription>표준 parameter 또는 model relation을 검색한 뒤 선택하세요.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Material parameter 카탈로그 검색"
            className="pl-9"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="key, 이름 또는 Quantity Kind"
            value={query}
          />
        </div>
        <div className="max-h-[55dvh] space-y-2 overflow-y-auto pr-1">
          {loading ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
              <LoaderCircle className="size-4 animate-spin" />
              Material Catalog를 불러오는 중입니다.
            </p>
          ) : failed ? (
            <div className="py-10 text-center text-sm text-destructive" role="alert">
              <p>Material Catalog를 불러오지 못했습니다.</p>
              <Button
                className="mt-3"
                onClick={() => Promise.all([parametersQuery.refetch(), modelsQuery.refetch()])}
                size="sm"
                type="button"
                variant="outline"
              >
                다시 시도
              </Button>
            </div>
          ) : null}
          {!loading && !failed
            ? entries.map((entry) => (
                <Button
                  className="h-auto w-full justify-start p-3 text-left whitespace-normal"
                  disabled={Boolean(pendingKey)}
                  key={entry.key}
                  onClick={async () => {
                    setPendingKey(entry.key)
                    setSelectionError('')
                    try {
                      await onSelect(entry)
                      setQuery('')
                      onOpenChange(false)
                    } catch (error) {
                      setSelectionError(error instanceof Error ? error.message : 'Catalog 항목을 불러오지 못했습니다.')
                    } finally {
                      setPendingKey('')
                    }
                  }}
                  type="button"
                  variant="outline"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <code className="text-xs font-semibold break-all text-orange-700">{entry.key}</code>
                      <Badge>{entry.kind}</Badge>
                      {pendingKey === entry.key ? <LoaderCircle className="size-3 animate-spin" /> : null}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {entry.label} · {entry.quantityKind}
                    </span>
                  </span>
                </Button>
              ))
            : null}
          {selectionError ? (
            <p className="py-2 text-sm text-destructive" role="alert">
              {selectionError}
            </p>
          ) : null}
          {!loading && !failed && !entries.length ? (
            <p className="py-12 text-center text-sm text-muted-foreground">조건에 맞는 카탈로그 항목이 없습니다.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function QualifierCatalogPickerDialog({
  names,
  onOpenChange,
  onSelect,
  open,
}: {
  names: readonly string[]
  onOpenChange: (open: boolean) => void
  onSelect: (name: string) => void
  open: boolean
}) {
  const [query, setQuery] = useState('')
  const filtered = names.filter((name) => name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Qualifier 탐색</DialogTitle>
          <DialogDescription>전역 qualifier와 선택한 parameter의 special qualifier만 표시합니다.</DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Qualifier 카탈로그 검색"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="qualifier 이름"
          value={query}
        />
        <div className="max-h-[50dvh] space-y-2 overflow-y-auto pr-1">
          {filtered.map((name) => (
            <Button
              className="w-full justify-start font-mono text-xs"
              key={name}
              onClick={() => {
                setQuery('')
                onSelect(name)
                onOpenChange(false)
              }}
              type="button"
              variant="outline"
            >
              {name}
            </Button>
          ))}
          {!filtered.length ? (
            <p className="py-10 text-center text-sm text-muted-foreground">선택 가능한 qualifier가 없습니다.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
