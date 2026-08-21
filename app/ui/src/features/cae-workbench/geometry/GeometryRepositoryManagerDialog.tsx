import { Archive, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { GeometryRepositoryPicker } from './GeometryRepositoryPicker'
import type { GeometryRepositoryRecord } from '@/api'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

export function GeometryRepositoryManagerDialog({
  geometry,
  onOpenChange,
  open,
  repositories = geometry.repositories,
}: {
  geometry: GeometryManagerState
  onOpenChange: (open: boolean) => void
  open: boolean
  repositories?: readonly GeometryRepositoryRecord[]
}) {
  const [descriptions, setDescriptions] = useState<Record<number, string>>({})
  const [busyId, setBusyId] = useState<number | null>(null)

  useEffect(() => {
    setDescriptions(Object.fromEntries(repositories.map((item) => [item.id, item.description ?? ''])))
  }, [repositories])

  const run = (id: number, action: () => Promise<unknown>, success: string) => {
    setBusyId(id)
    void action()
      .then(() => toast.success(success))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusyId(null))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Repository 관리</DialogTitle>
          <DialogDescription>Repository 이름은 Published coordinate의 일부이므로 변경할 수 없습니다.</DialogDescription>
        </DialogHeader>
        <div className="max-w-xl">
          <GeometryRepositoryPicker
            namespace={geometry.namespace}
            onChange={() => undefined}
            onCreate={geometry.createRepository}
            repositories={geometry.repositories}
            value={null}
          />
        </div>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs">
              <tr>
                <th className="p-3">Repository</th>
                <th className="p-3">설명</th>
                <th className="p-3">내용</th>
                <th className="p-3">상태</th>
                <th className="p-3">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {repositories.map((repository) => (
                <tr key={repository.id}>
                  <td className="p-3 font-mono text-xs">
                    {repository.namespace}/{repository.slug}
                  </td>
                  <td className="min-w-64 p-3">
                    <div className="flex gap-2">
                      <Input
                        aria-label={`${repository.slug} 설명`}
                        onChange={(event) =>
                          setDescriptions((current) => ({ ...current, [repository.id]: event.target.value }))
                        }
                        value={descriptions[repository.id] ?? ''}
                      />
                      <Button
                        disabled={busyId === repository.id}
                        onClick={() =>
                          run(
                            repository.id,
                            () =>
                              geometry.updateRepositoryDescription(repository.id, descriptions[repository.id] ?? ''),
                            'Repository 설명을 저장했습니다.',
                          )
                        }
                        size="sm"
                        variant="outline"
                      >
                        저장
                      </Button>
                    </div>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {repository.package_count ?? 0} packages · {repository.version_count ?? 0} versions
                  </td>
                  <td className="p-3">
                    <Badge className={repository.archived_at ? 'bg-muted' : 'bg-emerald-600 text-white'}>
                      {repository.archived_at ? 'Archived' : 'Active'}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <div className="flex gap-1">
                      {repository.archived_at ? (
                        <Button
                          disabled={busyId === repository.id}
                          onClick={() =>
                            run(
                              repository.id,
                              () => geometry.restoreRepository(repository.id),
                              'Repository를 복원했습니다.',
                            )
                          }
                          size="sm"
                          variant="outline"
                        >
                          <RotateCcw /> Restore
                        </Button>
                      ) : (
                        <Button
                          disabled={busyId === repository.id}
                          onClick={() =>
                            run(
                              repository.id,
                              () => geometry.archiveRepository(repository.id),
                              'Repository를 archive했습니다.',
                            )
                          }
                          size="sm"
                          variant="outline"
                        >
                          <Archive /> Archive
                        </Button>
                      )}
                      <Button
                        disabled={busyId === repository.id}
                        onClick={() => {
                          if (
                            window.confirm(
                              `${repository.namespace}/${repository.slug}와 하위 Package/Version을 삭제할까요? 참조 중이면 전체 작업이 거부됩니다.`,
                            )
                          ) {
                            run(
                              repository.id,
                              () => geometry.deleteRepository(repository.id),
                              'Repository를 삭제했습니다.',
                            )
                          }
                        }}
                        size="sm"
                        variant="destructive"
                      >
                        <Trash2 /> 삭제
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  )
}
