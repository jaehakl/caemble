import { AlertTriangle, RotateCcw, Upload } from 'lucide-react'
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
import type { GeometryDraftVersion } from '../types'
import type { GeometryManagerState } from './useGeometryWorkspaceState'
import { GeometryRepositoryPicker } from './GeometryRepositoryPicker'

export type GeometryDraftEditorState = Pick<
  GeometryManagerState,
  | 'busy'
  | 'confirmPublish'
  | 'createRepository'
  | 'discardDraft'
  | 'namespace'
  | 'previewDiagnostics'
  | 'previewError'
  | 'previewStale'
  | 'publishPlan'
  | 'publishReady'
  | 'repositories'
  | 'requestPublish'
  | 'selectedExport'
  | 'selectedExports'
  | 'setBump'
  | 'setPublishPlan'
  | 'setSelectedExport'
  | 'setVersion'
  | 'updateDescription'
  | 'updateDraftPackage'
  | 'updateSource'
>

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

export function GeometryDraftVersionEditor({
  authenticated,
  draft,
  geometry,
  onDiscard,
  onAuthoringStateChange,
}: {
  authenticated: boolean
  draft: GeometryDraftVersion
  geometry: GeometryDraftEditorState
  onDiscard?: (draft: GeometryDraftVersion) => void
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}) {
  const publish = () => {
    void geometry.requestPublish(draft.coordinate).catch((cause: unknown) => toast.error(errorMessage(cause)))
  }
  const updatePackage = (repository: string, packageName: string, repositoryId: number | null) => {
    try {
      return geometry.updateDraftPackage(draft.coordinate, { repository, packageName, repositoryId })
    } catch (cause) {
      toast.error(errorMessage(cause))
      return null
    }
  }

  return (
    <section aria-label="Draft Version editor" className="flex min-h-[30rem] min-w-0 flex-col">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs">
            {draft.repository}/{draft.packageName}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Draft Version{draft.baseGeometryVersionId ? ` · v${draft.version} 기반` : ' · 첫 Version'}
          </p>
        </div>
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
              geometry.discardDraft(draft.coordinate)
              onDiscard?.(draft)
            } catch (cause) {
              toast.error(errorMessage(cause))
            }
          }}
        >
          <RotateCcw /> 되돌리기
        </Button>
        <Button
          disabled={!authenticated || geometry.busy || !geometry.publishReady}
          size="sm"
          title={!authenticated ? 'Geometry 발행은 로그인 후 사용할 수 있습니다.' : undefined}
          onClick={publish}
        >
          <Upload /> 새 Version 발행
        </Button>
      </header>
      {geometry.previewError ? (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          마지막 정상 Viewer scene을 유지합니다. {geometry.previewError}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(28rem,1fr)_auto]">
        <CadEditor
          diagnostics={geometry.previewDiagnostics.filter((item) => item.file === draft.coordinate)}
          modelPath={
            draft.baseGeometryVersionId
              ? `file:///geometry-manager/${draft.baseGeometryVersionId}.tsx`
              : `file:///geometry-drafts/${encodeURIComponent(draft.draftId)}.tsx`
          }
          readOnly={geometry.busy}
          value={draft.source}
          onAuthoringStateChange={onAuthoringStateChange}
          onChange={geometry.updateSource}
        />
        <aside className="min-h-0 overflow-auto border-t bg-muted/10 p-4 text-xs">
          {draft.baseGeometryVersionId ? (
            <dl className="grid gap-3 border-b pb-4">
              <div>
                <dt className="font-semibold">Repository</dt>
                <dd className="mt-1 font-mono text-muted-foreground">{draft.repository}</dd>
              </div>
              <div>
                <dt className="font-semibold">Package</dt>
                <dd className="mt-1 font-mono text-muted-foreground">{draft.packageName}</dd>
              </div>
            </dl>
          ) : (
            <div className="grid gap-3 border-b pb-4">
              {authenticated ? (
                <label className="grid gap-1.5">
                  Repository
                  <GeometryRepositoryPicker
                    namespace={geometry.namespace}
                    onChange={(repository) => updatePackage(repository.slug, draft.packageName, repository.id)}
                    onCreate={geometry.createRepository}
                    repositories={geometry.repositories}
                    value={draft.repositoryId}
                  />
                  {draft.repositoryId === null ? (
                    <span className="text-amber-700">Repository를 선택해야 발행할 수 있습니다.</span>
                  ) : null}
                </label>
              ) : null}
              {!authenticated ? (
                <label className="grid gap-1.5">
                  Repository 이름
                  <Input
                    defaultValue={draft.repository}
                    key={`${draft.draftId}:repository:${draft.repository}`}
                    onBlur={(event) => {
                      if (!updatePackage(event.target.value.trim(), draft.packageName, null)) {
                        event.target.value = draft.repository
                      }
                    }}
                  />
                </label>
              ) : null}
              <label className="grid gap-1.5">
                Package
                <Input
                  defaultValue={draft.packageName}
                  key={`${draft.draftId}:package:${draft.packageName}`}
                  onBlur={(event) => {
                    if (!updatePackage(draft.repository, event.target.value.trim(), draft.repositoryId)) {
                      event.target.value = draft.packageName
                    }
                  }}
                />
              </label>
            </div>
          )}
          <label className="mt-4 grid gap-1.5">
            Description
            <textarea
              className="min-h-24 rounded-md border bg-background p-2"
              maxLength={2_000}
              value={draft.description}
              onChange={(event) => geometry.updateDescription(draft.coordinate, event.target.value)}
            />
          </label>
          {draft.baseGeometryVersionId ? (
            <label className="mt-4 grid gap-1.5">
              Version bump
              <select
                className="h-8 rounded-md border bg-background px-2"
                value={draft.bump}
                onChange={(event) =>
                  geometry.setBump(draft.coordinate, event.target.value as 'major' | 'minor' | 'patch')
                }
              >
                <option value="patch">patch</option>
                <option value="minor">minor</option>
                <option value="major">major</option>
              </select>
            </label>
          ) : (
            <label className="mt-4 grid gap-1.5">
              Publish Version
              <Input
                defaultValue={draft.version}
                key={`${draft.draftId}:version:${draft.version}`}
                onBlur={(event) => {
                  const version = event.target.value.trim()
                  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
                    event.target.value = draft.version
                    toast.error('Version은 major.minor.patch 형식이어야 합니다.')
                    return
                  }
                  geometry.setVersion(draft.coordinate, version)
                }}
              />
            </label>
          )}
        </aside>
      </div>

      <Dialog open={geometry.publishPlan !== null} onOpenChange={(open) => !open && geometry.setPublishPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <div className="grid max-h-[85dvh] gap-4 overflow-auto">
            <DialogHeader>
              <DialogTitle>Geometry 발행 계획</DialogTitle>
              <DialogDescription>
                Draft dependency를 child-first 순서로 발행하고 새 exact Version 좌표로 연결합니다.
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
                  void geometry.confirmPublish().catch((cause: unknown) => toast.error(errorMessage(cause)))
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
