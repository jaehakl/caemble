import { useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, CirclePlus, RotateCcw, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
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
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import { cn } from '@/lib/utils'
import { draftGeometrySource } from './draftGeometrySource'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

function formValue(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim()
}

export function GeometryDrafts({
  authenticated,
  geometry,
  onAuthoringStateChange,
}: {
  authenticated: boolean
  geometry: GeometryManagerState
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}) {
  const [dialog, setDialog] = useState<'namespace' | 'create' | null>(null)
  const [busy, setBusy] = useState(false)
  const drafts = Object.values(geometry.drafts)
  const selectedDraft = geometry.selectedCoordinate ? (geometry.drafts[geometry.selectedCoordinate] ?? null) : null

  useEffect(() => {
    if (!selectedDraft && drafts[0]) geometry.setSelectedCoordinate(drafts[0].coordinate)
  }, [drafts, geometry, selectedDraft])

  const openCreate = () => setDialog(geometry.namespace ? 'create' : 'namespace')
  const submitNamespace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    void geometry
      .setNamespace(formValue(new FormData(event.currentTarget), 'namespace'))
      .then(() => setDialog('create'))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }
  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      geometry.createDraft({
        repositoryId: Number(formValue(form, 'repositoryId')) || null,
        repository: formValue(form, 'repository'),
        packageName: formValue(form, 'package'),
        description: formValue(form, 'description'),
        source: String(form.get('source') ?? ''),
      })
      setDialog(null)
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const publish = (coordinate: GeometryModuleCoordinate) => {
    void geometry
      .requestPublish(coordinate)
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <section aria-label="Local Geometry drafts" className="grid h-full min-h-0 grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r bg-muted/10">
        <header className="flex items-center justify-between gap-2 border-b p-3">
          <div>
            <h2 className="text-sm font-semibold">Local Drafts</h2>
            <p className="text-xs text-muted-foreground">Experiment와 독립적으로 현재 브라우저 세션에 저장됩니다.</p>
          </div>
          <Button onClick={openCreate} size="sm" variant="outline">
            <CirclePlus /> 새 Geometry
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {drafts.map((draft) => (
            <button
              className={cn(
                'mb-1 grid w-full gap-1 rounded px-2 py-2 text-left hover:bg-accent',
                selectedDraft?.coordinate === draft.coordinate && 'bg-accent',
              )}
              key={draft.draftId}
              type="button"
              onClick={() => geometry.setSelectedCoordinate(draft.coordinate)}
            >
              <span className="truncate font-mono text-xs">{draft.coordinate}</span>
              <span className="text-[10px] text-muted-foreground">
                {draft.baseGeometryVersionId ? `v${draft.version} 기반 · ${draft.bump}` : '새 Geometry · v0.1.0'}
              </span>
            </button>
          ))}
          {!drafts.length ? (
            <p className="p-5 text-center text-xs text-muted-foreground">열려 있는 local draft가 없습니다.</p>
          ) : null}
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col">
        {!selectedDraft ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            Geometry를 새로 만들거나 Catalog/Workspace에서 draft로 여세요.
          </div>
        ) : (
          <>
            <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{selectedDraft.coordinate}</span>
              {geometry.selectedExports.length > 1 ? (
                <select
                  aria-label="Preview export"
                  className="h-8 rounded-md border bg-background px-2 text-xs"
                  value={geometry.selectedExport ?? ''}
                  onChange={(event) => geometry.setSelectedExport(event.target.value)}
                >
                  {geometry.selectedExports.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              ) : null}
              {geometry.previewStale ? (
                <Badge className="gap-1 rounded-sm bg-amber-500 text-white">
                  <AlertTriangle className="size-3" /> Preview stale
                </Badge>
              ) : (
                <Badge className="rounded-sm bg-muted">Preview current</Badge>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  try {
                    geometry.discardDraft(selectedDraft.coordinate)
                  } catch (cause) {
                    toast.error(cause instanceof Error ? cause.message : String(cause))
                  }
                }}
              >
                <RotateCcw /> 되돌리기
              </Button>
              <Button
                disabled={!authenticated || geometry.busy || !geometry.publishReady}
                size="sm"
                title={!authenticated ? 'Geometry 저장은 로그인 후 사용할 수 있습니다.' : undefined}
                onClick={() => publish(selectedDraft.coordinate)}
              >
                <Upload /> 새 Version 발행
              </Button>
            </header>
            {geometry.previewError ? (
              <div
                className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                role="alert"
              >
                마지막 정상 Viewer scene을 유지합니다. {geometry.previewError}
              </div>
            ) : null}
            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_16rem]">
              <CadEditor
                diagnostics={geometry.previewDiagnostics.filter((item) => item.file === selectedDraft.coordinate)}
                modelPath={`file:///geometries/${encodeURIComponent(selectedDraft.coordinate)}.tsx`}
                readOnly={geometry.busy}
                value={selectedDraft.source}
                onAuthoringStateChange={onAuthoringStateChange}
                onChange={geometry.updateSource}
              />
              <aside className="min-h-0 overflow-auto border-l bg-muted/10 p-4 text-xs">
                <label className="grid gap-1.5">
                  Description
                  <textarea
                    className="min-h-24 rounded-md border bg-background p-2"
                    maxLength={2_000}
                    value={selectedDraft.description}
                    onChange={(event) => geometry.updateDescription(selectedDraft.coordinate, event.target.value)}
                  />
                </label>
                {selectedDraft.baseGeometryVersionId ? (
                  <label className="mt-4 grid gap-1.5">
                    Version bump
                    <select
                      className="h-8 rounded-md border bg-background px-2"
                      value={selectedDraft.bump}
                      onChange={(event) =>
                        geometry.setBump(selectedDraft.coordinate, event.target.value as 'major' | 'minor' | 'patch')
                      }
                    >
                      <option value="patch">patch</option>
                      <option value="minor">minor</option>
                      <option value="major">major</option>
                    </select>
                  </label>
                ) : null}
              </aside>
            </div>
          </>
        )}
      </main>

      <Dialog open={dialog === 'namespace'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <form className="grid gap-4" onSubmit={submitNamespace}>
            <DialogHeader>
              <DialogTitle>기본 Geometry namespace</DialogTitle>
              <DialogDescription>새 Repository에만 적용되며 기존 exact Version은 변경되지 않습니다.</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              defaultValue={geometry.namespace ?? ''}
              maxLength={32}
              minLength={3}
              name="namespace"
              pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
              required
            />
            <DialogFooter>
              <Button disabled={busy} type="submit">
                변경
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'create'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-2xl">
          <form className="grid max-h-[85dvh] gap-4 overflow-auto" onSubmit={submitCreate}>
            <DialogHeader>
              <DialogTitle>새 Geometry draft</DialogTitle>
              <DialogDescription>
                생성한 source는 Experiment와 독립적으로 편집하고 Viewer에서 확인합니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                기존 Repository
                <select className="h-9 rounded-md border bg-background px-3" name="repositoryId">
                  <option value="">현재 namespace의 새 Repository</option>
                  {geometry.repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.namespace}/{repository.slug}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Repository slug
                <Input defaultValue="common" name="repository" required />
              </label>
              <label className="grid gap-1 text-sm">
                Package name
                <Input defaultValue="new-geometry" name="package" required />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <Input name="description" />
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
              <Button type="button" variant="outline" onClick={() => setDialog(null)}>
                취소
              </Button>
              <Button type="submit">Draft 만들기</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={geometry.publishPlan !== null} onOpenChange={(open) => !open && geometry.setPublishPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <div className="grid max-h-[85dvh] gap-4 overflow-auto">
            <DialogHeader>
              <DialogTitle>Geometry 발행 계획</DialogTitle>
              <DialogDescription>
                local dependency를 child-first 순서로 발행하고 모든 @local import를 exact Version으로 바꿉니다.
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-2 text-sm">
              {geometry.publishPlan?.value.steps.map((step, index) => (
                <li className="rounded-md border p-3" key={`${step.draftId}:${step.coordinate}`}>
                  {index + 1}. <span className="font-mono">{step.coordinate}</span>
                </li>
              ))}
            </ol>
            <DialogFooter>
              <Button variant="outline" onClick={() => geometry.setPublishPlan(null)}>
                취소
              </Button>
              <Button
                disabled={geometry.busy}
                onClick={() =>
                  void geometry
                    .confirmPublish()
                    .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
                }
              >
                계획대로 발행
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
