import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import type { GeometryManagerListRow } from './geometryManagerTypes'

export function GeometryPackageList({
  rows,
  managerView,
  selectedCatalogKey,
  selectedDraftCoordinate,
  selectedPackageId,
  checkedPackageIds,
  onSelectExample,
  onSelectDraft,
  onSelectPackage,
  onTogglePackage,
  examplesVisible,
  examplesLoading,
  examplesError,
  workspaceVisible,
  workspaceLoading,
  workspaceError,
  authenticated,
  total,
  page,
  pageSize,
  pageSizes,
  onPageSizeChange,
  onNextPage,
}: {
  rows: readonly GeometryManagerListRow[]
  managerView: 'examples' | 'workspace'
  selectedCatalogKey: string | null
  selectedDraftCoordinate: string | null
  selectedPackageId: number | null
  checkedPackageIds: ReadonlySet<number>
  onSelectExample: (key: string) => void
  onSelectDraft: (coordinate: GeometryModuleCoordinate) => void
  onSelectPackage: (id: number) => void
  onTogglePackage: (id: number) => void
  examplesVisible: boolean
  examplesLoading: boolean
  examplesError: boolean
  workspaceVisible: boolean
  workspaceLoading: boolean
  workspaceError: boolean
  authenticated: boolean
  total: number
  page: number
  pageSize: number
  pageSizes: readonly number[]
  onPageSizeChange: (value: number) => void
  onNextPage: () => void
}) {
  const hasLoading = examplesLoading || workspaceLoading

  return (
    <>
      <div aria-label="Geometry Packages list" className="min-h-0 flex-1 divide-y overflow-auto" role="list">
        {rows.map((row) => {
          if (row.kind === 'example') {
            return (
              <button
                aria-current={managerView === 'examples' && selectedCatalogKey === row.item.key}
                className={cn(
                  'grid w-full gap-1 border-l-4 border-violet-400 bg-violet-50/60 px-3 py-2.5 text-left hover:bg-violet-100',
                  managerView === 'examples' && selectedCatalogKey === row.item.key && 'bg-violet-100',
                )}
                key={`example:${row.item.key}`}
                onClick={() => onSelectExample(row.item.key)}
                type="button"
              >
                <span className="flex items-center justify-between gap-2 text-sm font-medium">
                  <span className="truncate">{row.item.title}</span>
                  <Badge className="border-violet-300 bg-violet-100 text-violet-900">Example</Badge>
                </span>
                <span className="truncate font-mono text-[11px] text-violet-700">
                  Examples/{row.item.repository}/{row.item.key}
                </span>
              </button>
            )
          }
          if (row.kind === 'draft') {
            return (
              <button
                aria-current={selectedDraftCoordinate === row.item.coordinate}
                className={cn(
                  'grid w-full gap-1 px-3 py-2.5 text-left hover:bg-accent',
                  selectedDraftCoordinate === row.item.coordinate && 'bg-accent',
                )}
                key={`draft:${row.item.draftId}`}
                onClick={() => onSelectDraft(row.item.coordinate)}
                type="button"
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs">
                    {row.item.coordinate.replace(/^caemble:geometry\//u, '').replace(/@local$/u, '')}
                  </span>
                  <Badge>Draft</Badge>
                </span>
                <span className="text-[10px] text-muted-foreground">Draft Version</span>
              </button>
            )
          }
          return (
            <div className="flex items-start gap-3 px-3 py-2.5 hover:bg-accent" key={`package:${row.item.id}`}>
              <input
                aria-label={`${row.item.name} 선택`}
                checked={checkedPackageIds.has(row.item.id)}
                onChange={() => onTogglePackage(row.item.id)}
                onClick={(event) => event.stopPropagation()}
                type="checkbox"
              />
              <button
                aria-current={selectedPackageId === row.item.id}
                className={cn(
                  'flex min-w-0 flex-1 items-start gap-3 text-left',
                  selectedPackageId === row.item.id && 'font-medium',
                )}
                onClick={() => onSelectPackage(row.item.id)}
                type="button"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">
                    {row.item.namespace}/{row.item.repository}/{row.item.name}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {row.item.version_count} versions · latest {row.item.latest_version ?? '없음'}
                  </span>
                </span>
                <Badge className={row.item.repository_archived_at ? 'bg-muted' : 'bg-emerald-600 text-white'}>
                  {row.item.repository_archived_at ? 'Archived' : 'Active'}
                </Badge>
                <ChevronRight aria-hidden="true" className="mt-1 size-4 shrink-0 text-muted-foreground" />
              </button>
            </div>
          )
        })}
        {examplesVisible && examplesLoading ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">Examples 목록을 불러오는 중입니다.</p>
        ) : examplesVisible && examplesError ? (
          <p className="px-3 py-3 text-xs text-destructive">Examples 목록을 불러오지 못했습니다.</p>
        ) : null}
        {authenticated && workspaceVisible && workspaceLoading ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">Workspace 목록을 불러오는 중입니다.</p>
        ) : authenticated && workspaceVisible && workspaceError ? (
          <p className="px-3 py-3 text-xs text-destructive">Workspace 목록을 불러오지 못했습니다.</p>
        ) : null}
        {!rows.length && !hasLoading ? (
          <div className="grid h-32 place-items-center px-6 text-center text-xs text-muted-foreground">
            표시할 Geometry가 없습니다.
          </div>
        ) : null}
      </div>
      {authenticated && workspaceVisible ? (
        <div className="flex items-center justify-between gap-2 border-t p-3 text-xs">
          <span>{total.toLocaleString()} packages</span>
          <div className="flex items-center gap-1">
            <select
              aria-label="페이지 크기"
              className="h-8 rounded border bg-background px-1"
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              value={pageSize}
            >
              {pageSizes.map((size) => (
                <option key={size}>{size}</option>
              ))}
            </select>
            <Button disabled={(page + 1) * pageSize >= total} onClick={onNextPage} size="sm" variant="outline">
              더 보기
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}
