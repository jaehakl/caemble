import type { FormEvent } from 'react'
import { GitFork } from 'lucide-react'
import type { GeometryRepositoryRecord } from '@/api'
import type { CatalogGeometryDetail } from '@/api/catalog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { GeometryRepositoryPicker } from './GeometryRepositoryPicker'
import { GeometryRepositoryManagerDialog, type GeometryRepositoryManagerState } from './GeometryRepositoryManagerDialog'
import { GeometryUsageDialog } from './GeometryUsageDialog'
import { GeometryWorkspaceSettingsDialog } from './GeometryWorkspaceSettingsDialog'
import { draftGeometrySource } from './draftGeometrySource'

const slugPattern = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?'

export function GeometryManagerDialogs({
  authenticated,
  geometry,
  forkDetail,
  forkRepositoryId,
  setForkDetail,
  setForkRepositoryId,
  onSubmitFork,
  createDialogOpen,
  setCreateDialogOpen,
  createRepositoryId,
  setCreateRepositoryId,
  onSubmitGeometry,
  usageExample,
  onCloseUsage,
  onOpenGeometrySource,
  repositoryManagerOpen,
  setRepositoryManagerOpen,
  repositories,
  workspaceSettingsOpen,
  setWorkspaceSettingsOpen,
  namespace,
  namespacePending,
  onSubmitNamespace,
}: {
  authenticated: boolean
  geometry: GeometryRepositoryManagerState
  forkDetail: CatalogGeometryDetail | null
  forkRepositoryId: number | null
  setForkDetail: (value: CatalogGeometryDetail | null) => void
  setForkRepositoryId: (value: number | null) => void
  onSubmitFork: (event: FormEvent<HTMLFormElement>) => void
  createDialogOpen: boolean
  setCreateDialogOpen: (value: boolean) => void
  createRepositoryId: number | null
  setCreateRepositoryId: (value: number | null) => void
  onSubmitGeometry: (event: FormEvent<HTMLFormElement>) => void
  usageExample: string | null
  onCloseUsage: () => void
  onOpenGeometrySource: () => void
  repositoryManagerOpen: boolean
  setRepositoryManagerOpen: (value: boolean) => void
  repositories: readonly GeometryRepositoryRecord[]
  workspaceSettingsOpen: boolean
  setWorkspaceSettingsOpen: (value: boolean) => void
  namespace: string | null
  namespacePending: boolean
  onSubmitNamespace: (value: string) => void
}) {
  return (
    <>
      <Dialog open={forkDetail !== null} onOpenChange={(open) => !open && setForkDetail(null)}>
        <DialogContent className="sm:max-w-xl">
          {forkDetail ? (
            <form className="grid gap-4" onSubmit={onSubmitFork}>
              <DialogHeader>
                <DialogTitle>개인 Repository로 Fork</DialogTitle>
                <DialogDescription>
                  Example source는 변경하지 않고 개인 Workspace에 편집 가능한 Draft Version을 만듭니다.
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-sm font-medium">{forkDetail.title}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{forkDetail.key}</p>
              </div>
              <div className="grid gap-3">
                <label className="grid gap-1 text-sm sm:col-span-2">
                  Repository
                  <GeometryRepositoryPicker
                    namespace={geometry.namespace}
                    onChange={(repository) => setForkRepositoryId(repository.id)}
                    onCreate={geometry.createRepository}
                    repositories={geometry.repositories}
                    value={forkRepositoryId}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Package name
                  <Input
                    defaultValue={forkDetail.key}
                    key={forkDetail.key}
                    maxLength={64}
                    name="package"
                    pattern={slugPattern}
                    required
                  />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">첫 Version은 0.1.0으로 시작합니다.</p>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForkDetail(null)}>
                  취소
                </Button>
                <Button type="submit">
                  <GitFork /> Draft Version 만들기
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <form className="grid max-h-[85dvh] gap-4 overflow-auto" onSubmit={onSubmitGeometry}>
            <DialogHeader>
              <DialogTitle>새 Geometry</DialogTitle>
              <DialogDescription>
                새 Package와 Draft Version을 세션에 만들고 Viewer에서 바로 미리봅니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              {authenticated ? (
                <label className="grid gap-1 text-sm sm:col-span-2">
                  Repository
                  <GeometryRepositoryPicker
                    namespace={geometry.namespace}
                    onChange={(repository) => setCreateRepositoryId(repository.id)}
                    onCreate={geometry.createRepository}
                    repositories={geometry.repositories}
                    value={createRepositoryId}
                  />
                </label>
              ) : (
                <label className="grid gap-1 text-sm">
                  Repository 이름
                  <Input defaultValue="common" maxLength={64} name="repository" pattern={slugPattern} required />
                </label>
              )}
              <label className="grid gap-1 text-sm">
                Package name
                <Input defaultValue="new-geometry" maxLength={64} name="package" pattern={slugPattern} required />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <Input maxLength={2_000} name="description" />
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              TSX source
              <textarea
                className="min-h-72 rounded-md border bg-background p-3 font-mono text-xs"
                defaultValue={draftGeometrySource('new-geometry')}
                name="source"
                required
                spellCheck={false}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateDialogOpen(false)}>
                취소
              </Button>
              <Button type="submit">Draft Version 만들기</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GeometryUsageDialog
        snippet={usageExample ?? ''}
        onOpenChange={(open) => !open && onCloseUsage()}
        onOpenGeometrySource={onOpenGeometrySource}
        open={usageExample !== null}
      />
      <GeometryWorkspaceSettingsDialog
        namespace={namespace}
        onOpenChange={setWorkspaceSettingsOpen}
        onSubmit={onSubmitNamespace}
        open={workspaceSettingsOpen}
        pending={namespacePending}
      />
      <GeometryRepositoryManagerDialog
        geometry={geometry}
        onOpenChange={setRepositoryManagerOpen}
        open={repositoryManagerOpen}
        repositories={repositories}
      />
    </>
  )
}
