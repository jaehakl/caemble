import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, LoaderCircle } from 'lucide-react'
import { dbTables, type CodeEntityHistoryItem } from '@/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type HistoryDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  id: number | null
  onSelect: (id: number) => void
}

function orderHistory(items: CodeEntityHistoryItem[], rootId: number) {
  const children = new Map<number | null, CodeEntityHistoryItem[]>()
  for (const item of items) {
    const siblings = children.get(item.parent_id) ?? []
    siblings.push(item)
    children.set(item.parent_id, siblings)
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.id - right.id)

  const ordered: Array<{ item: CodeEntityHistoryItem; depth: number }> = []
  const visited = new Set<number>()
  const visit = (item: CodeEntityHistoryItem, depth: number) => {
    if (visited.has(item.id)) return
    visited.add(item.id)
    ordered.push({ item, depth })
    for (const child of children.get(item.id) ?? []) visit(child, depth + 1)
  }
  const root = items.find((item) => item.id === rootId)
  if (root) visit(root, 0)
  for (const item of items) visit(item, 0)
  return ordered
}

export function HistoryDialog({ open, onOpenChange, id, onSelect }: HistoryDialogProps) {
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const label = 'Experiment'
  const historyQuery = useQuery({
    queryKey: ['cae-workbench', 'experiment', 'history', id],
    queryFn: () => dbTables.Experiment.history(id!),
    enabled: open && id !== null,
  })

  useEffect(() => {
    if (historyQuery.data) setSelectedId(historyQuery.data.selected_id)
  }, [historyQuery.data])

  const rows = useMemo(
    () => (historyQuery.data ? orderHistory(historyQuery.data.items, historyQuery.data.root_id) : []),
    [historyQuery.data],
  )

  const choose = () => {
    if (selectedId === null) return
    onSelect(selectedId)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{label} History</DialogTitle>
          <DialogDescription>{label} 계보를 확인하고 불러올 버전을 선택합니다.</DialogDescription>
        </DialogHeader>

        <div className="min-h-64 overflow-auto rounded-lg border bg-muted/10 p-2">
          {id === null ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              먼저 저장된 {label}를 불러오세요.
            </div>
          ) : historyQuery.isLoading ? (
            <div className="flex h-64 items-center justify-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="animate-spin" /> 계보를 불러오는 중입니다.
            </div>
          ) : historyQuery.isError ? (
            <div className="flex h-64 items-center justify-center text-sm text-destructive">
              계보를 불러오지 못했습니다.
            </div>
          ) : (
            <div aria-label={`${label} 계보`} className="space-y-1" role="tree">
              {rows.map(({ item, depth }) => {
                const isSelected = selectedId === item.id
                const isCurrent = historyQuery.data?.selected_id === item.id
                const isRoot = historyQuery.data?.root_id === item.id
                return (
                  <button
                    key={item.id}
                    aria-level={depth + 1}
                    aria-selected={isSelected}
                    className="flex w-full items-start gap-3 rounded-md border border-transparent px-3 py-2 text-left hover:bg-accent aria-selected:border-primary/40 aria-selected:bg-primary/10"
                    role="treeitem"
                    style={{ paddingLeft: `${depth * 1.5 + 0.75}rem` }}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    onDoubleClick={() => {
                      onSelect(item.id)
                      onOpenChange(false)
                    }}
                  >
                    <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.name}</span>
                        <span className="text-xs text-muted-foreground">#{item.id}</span>
                        {isRoot ? (
                          <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium">Root</span>
                        ) : null}
                        {isCurrent ? (
                          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground">
                            Current
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {item.description || '설명 없음'} · {item.user_id ? 'User' : 'Public'}
                        {item.updated_at ? ` · ${new Date(item.updated_at).toLocaleString()}` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            취소
          </Button>
          <Button disabled={selectedId === null || historyQuery.isLoading} onClick={choose}>
            선택한 버전 불러오기
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
