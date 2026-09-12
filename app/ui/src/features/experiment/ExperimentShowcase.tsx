import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SavedExperimentRecord, UserData } from '@/api'
import { privateQueryScope } from '@/features/auth/queryKeys'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { availableExperimentsQueryOptions } from './queryOptions'
import { ExperimentCard } from './ExperimentCard'
import { filterShowcase, showcaseGroups, type ShowcaseSort } from './showcaseListing'
import { useDeleteExperiment } from './useDeleteExperiment'

export function ExperimentShowcase({
  user,
  selectedId,
  onSelect,
  onEdit,
  onDeleteSelected,
  mode = 'browse',
  revealId,
  busy = false,
}: {
  user: UserData | null
  selectedId: number | null
  onSelect: (row: SavedExperimentRecord) => void
  onEdit?: (row: SavedExperimentRecord) => void
  onDeleteSelected?: (row: SavedExperimentRecord) => void
  mode?: 'browse' | 'load' | 'save'
  revealId?: number | null
  busy?: boolean
}) {
  const scope = privateQueryScope(user)
  const query = useQuery(availableExperimentsQueryOptions(scope))
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ShowcaseSort>('created-desc')
  const [repositories, setRepositories] = useState<string[] | null>(null)
  const [versionsIdentity, setVersionsIdentity] = useState<string | null>(null)
  const versionTrigger = useRef<HTMLElement | null>(null)
  const container = useRef<HTMLElement | null>(null)
  const groups = useMemo(() => showcaseGroups(query.data), [query.data])
  const repositoryOptions = [...new Set(groups.map((group) => group.repository))].sort()
  const visible = filterShowcase(groups, search, repositories, sort)
  const versionGroup = groups.find((group) => group.identity === versionsIdentity)
  const deletion = useDeleteExperiment(scope, selectedId, onDeleteSelected)
  useEffect(() => {
    if (revealId == null) return
    setSearch('')
    setRepositories(null)
    const frame = requestAnimationFrame(() =>
      container.current?.querySelector(`[data-experiment-id="${revealId}"]`)?.scrollIntoView?.({ block: 'nearest' }),
    )
    return () => cancelAnimationFrame(frame)
  }, [revealId, query.data])
  const card = (row: SavedExperimentRecord, onVersions?: () => void) => (
    <ExperimentCard
      key={row.id}
      row={row}
      selected={row.id === selectedId}
      deleting={deletion.isPending}
      onSelect={() => {
        onSelect(row)
        setVersionsIdentity(null)
      }}
      disabled={
        busy ||
        (mode === 'save' && !(user && (user.roles.includes('admin') || (!row.isDemo && row.user_id === user.id))))
      }
      onEdit={mode === 'browse' && onEdit ? () => onEdit(row) : undefined}
      onVersions={onVersions}
      onDelete={
        mode === 'browse' && user && (user.roles.includes('admin') || (!row.isDemo && row.user_id === user.id))
          ? () => deletion.mutate(row)
          : undefined
      }
    />
  )
  return (
    <section ref={container} aria-label="Experiment Showcase" className="flex h-full min-h-0 flex-col">
      <header className="space-y-3 border-b p-4">
        <h1 className="text-lg font-semibold">Experiment Showcase</h1>
        <Input
          aria-label="Experiment 검색"
          placeholder="이름, 설명 또는 key 검색"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Experiment 정렬"
          className="w-full rounded-md border bg-background p-2 text-sm"
          value={sort}
          onChange={(event) => setSort(event.target.value as ShowcaseSort)}
        >
          <option value="created-desc">생성일 최신순</option>
          <option value="created-asc">생성일 오래된순</option>
          <option value="name-asc">이름 오름차순</option>
          <option value="name-desc">이름 내림차순</option>
          <option value="measurements-desc">Measurement 많은순</option>
          <option value="measurements-asc">Measurement 적은순</option>
        </select>
        <div role="group" aria-label="Repository 필터" className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={repositories === null}
            className="rounded-full border px-3 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            onClick={() => setRepositories(null)}
          >
            전체
          </button>
          {repositoryOptions.map((repository) => (
            <button
              type="button"
              key={repository}
              aria-pressed={repositories === null || repositories.includes(repository)}
              className="rounded-full border px-3 py-1 text-xs aria-pressed:bg-primary aria-pressed:text-primary-foreground"
              onClick={() =>
                setRepositories((current) => {
                  const active = current ?? repositoryOptions
                  return active.includes(repository)
                    ? active.filter((value) => value !== repository)
                    : [...active, repository]
                })
              }
            >
              {repository}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {query.isPending ? <p role="status">Experiment 목록을 불러오는 중…</p> : null}
        {query.isError ? (
          <div role="alert">
            목록을 불러오지 못했습니다.{' '}
            <button type="button" onClick={() => void query.refetch()}>
              다시 시도
            </button>
          </div>
        ) : null}
        {query.isSuccess && !visible.length ? (
          <p className="py-10 text-center text-sm text-muted-foreground">조건에 맞는 Experiment가 없습니다.</p>
        ) : null}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
          {visible.map((group) =>
            card(group.versions[0], () => {
              versionTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
              setVersionsIdentity(group.identity)
            }),
          )}
        </div>
      </div>
      <Dialog
        open={Boolean(versionGroup)}
        onOpenChange={(open) => {
          if (!open) setVersionsIdentity(null)
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-auto sm:max-w-4xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (versionTrigger.current?.isConnected) versionTrigger.current.focus()
            else container.current?.querySelector('input')?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{versionGroup?.versions[0].name} · 이전 버전</DialogTitle>
            <DialogDescription>이전 버전을 선택하여 Viewer에서 확인합니다.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
            {versionGroup?.versions.slice(1).map((row) => card(row))}
          </div>
          {versionGroup?.versions.length === 1 ? (
            <p className="text-sm text-muted-foreground">이전 버전이 없습니다.</p>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  )
}
