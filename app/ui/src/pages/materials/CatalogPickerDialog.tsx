import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { materialCatalogEntries } from './material-utils'

export function MaterialCatalogPickerDialog({
  onOpenChange,
  onSelect,
  open,
}: {
  onOpenChange: (open: boolean) => void
  onSelect: (key: string) => void
  open: boolean
}) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return materialCatalogEntries.filter(
      (entry) => !needle || `${entry.key} ${entry.label} ${entry.quantityKind}`.toLocaleLowerCase().includes(needle),
    )
  }, [query])

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
      open={open}
    >
      <DialogContent className="max-w-3xl">
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
          {filtered.map((entry) => (
            <Button
              className="h-auto w-full justify-start p-3 text-left whitespace-normal"
              key={entry.key}
              onClick={() => {
                setQuery('')
                onSelect(entry.key)
                onOpenChange(false)
              }}
              type="button"
              variant="outline"
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold break-all text-orange-700">{entry.key}</code>
                  <Badge>{entry.kind}</Badge>
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {entry.label} · {entry.quantityKind}
                </span>
              </span>
            </Button>
          ))}
          {!filtered.length ? (
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
