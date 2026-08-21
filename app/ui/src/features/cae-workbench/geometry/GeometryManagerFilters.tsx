import { RotateCcw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { GEOMETRY_MANAGER_ALL, GEOMETRY_MANAGER_EXAMPLES } from './geometryManagerTypes'

type RepositoryOption = Readonly<{ key: string; label: string; example: boolean }>

export function GeometryManagerFilters({
  authenticated,
  isAdmin,
  search,
  namespace,
  repository,
  owner,
  archive,
  namespaces,
  owners,
  repositoryOptions,
  onSearchChange,
  onNamespaceChange,
  onRepositoryChange,
  onOwnerChange,
  onArchiveChange,
  onReset,
  onOpenRepositoryManager,
}: {
  authenticated: boolean
  isAdmin: boolean
  search: string
  namespace: string
  repository: string
  owner: string
  archive: 'active' | 'archived' | 'all'
  namespaces: readonly string[]
  owners: readonly string[]
  repositoryOptions: readonly RepositoryOption[]
  onSearchChange: (value: string) => void
  onNamespaceChange: (value: string) => void
  onRepositoryChange: (value: string) => void
  onOwnerChange: (value: string) => void
  onArchiveChange: (value: 'active' | 'archived' | 'all') => void
  onReset: () => void
  onOpenRepositoryManager: () => void
}) {
  return (
    <div className="grid gap-2 border-b bg-muted/10 p-3 lg:grid-cols-[minmax(14rem,1fr)_minmax(9rem,0.7fr)_minmax(11rem,0.8fr)_auto]">
      <div className="relative min-w-0 lg:col-span-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Geometry 검색"
          className="pl-9"
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="제목, key, namespace/repository/package 검색"
          value={search}
        />
      </div>
      <select
        aria-label="Namespace"
        className={cn(
          'h-9 min-w-0 rounded-md border bg-background px-2 text-sm',
          namespace === GEOMETRY_MANAGER_EXAMPLES && 'border-violet-400 bg-violet-50 text-violet-950',
        )}
        onChange={(event) => onNamespaceChange(event.target.value)}
        value={namespace}
      >
        <option value={GEOMETRY_MANAGER_ALL}>모든 namespace</option>
        <option value={GEOMETRY_MANAGER_EXAMPLES}>Examples</option>
        {namespaces.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select
        aria-label="Repository"
        className={cn(
          'h-9 min-w-0 rounded-md border bg-background px-2 text-sm',
          repository.startsWith(`${GEOMETRY_MANAGER_EXAMPLES}/`) && 'border-violet-400 bg-violet-50 text-violet-950',
        )}
        onChange={(event) => onRepositoryChange(event.target.value)}
        value={repository}
      >
        <option value={GEOMETRY_MANAGER_ALL}>모든 Repository</option>
        {repositoryOptions.map((item) => (
          <option key={item.key} value={item.key}>
            {item.label}
          </option>
        ))}
      </select>
      <div className="flex min-w-0 gap-2">
        {authenticated ? (
          <Button onClick={onOpenRepositoryManager} size="sm" variant="outline">
            Repository 관리
          </Button>
        ) : null}
        <Button aria-label="Geometry 필터 초기화" onClick={onReset} size="icon" title="필터 초기화" variant="outline">
          <RotateCcw />
        </Button>
      </div>
      {authenticated ? (
        <div className={cn('grid gap-2 sm:col-span-2 lg:col-span-4', isAdmin ? 'sm:grid-cols-2' : 'grid-cols-1')}>
          {isAdmin ? (
            <select
              aria-label="Owner 필터"
              className="h-9 rounded-md border bg-background px-2 text-xs"
              onChange={(event) => onOwnerChange(event.target.value)}
              value={owner}
            >
              <option value="">모든 owner</option>
              <option value="__orphan__">Orphaned</option>
              {owners.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : null}
          <select
            aria-label="Archive 필터"
            className="h-9 rounded-md border bg-background px-2 text-xs"
            onChange={(event) => onArchiveChange(event.target.value as 'active' | 'archived' | 'all')}
            value={archive}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">전체</option>
          </select>
        </div>
      ) : namespace !== GEOMETRY_MANAGER_EXAMPLES ? (
        <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
          세션 Package는 편집과 Viewer 미리보기를 사용할 수 있습니다.
        </p>
      ) : null}
    </div>
  )
}
