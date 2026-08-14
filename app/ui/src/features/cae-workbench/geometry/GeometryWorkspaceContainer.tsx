import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'
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
import type { CadDiagnostic, GeometryModuleCoordinate } from '@/lib/cad'
import type { GeometryWorkspaceState } from './useGeometryWorkspaceState'
import { GeometryWorkspace } from './GeometryWorkspace'

const initialSource = `import { type Geometry, type Vec3 } from '@caemble/core'

export const NotchedConductor: Geometry<{
  notchPosition: Vec3
  notchSize: Vec3
  size: Vec3
}> = ({
  notchPosition = [0, 4, 2.5],
  notchSize = [30, 5, 6],
  size = [100, 12, 10],
}) => (
  <subtract>
    <box size={size} />
    <box pos={notchPosition} size={notchSize} />
  </subtract>
)
`

function formValue(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim()
}

export function GeometryWorkspaceContainer({
  authenticated,
  diagnostics,
  geometry,
  onOpenManager,
}: {
  authenticated: boolean
  diagnostics: readonly CadDiagnostic[]
  geometry: GeometryWorkspaceState
  onOpenManager: () => void
}) {
  const [dialog, setDialog] = useState<'namespace' | 'create' | null>(null)
  const [openCreateAfterNamespace, setOpenCreateAfterNamespace] = useState(false)
  const [busy, setBusy] = useState(false)

  const openCreate = () => {
    if (!geometry.namespace) {
      setOpenCreateAfterNamespace(true)
      setDialog('namespace')
      return
    }
    setDialog('create')
  }

  const submitNamespace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const namespace = formValue(new FormData(event.currentTarget), 'namespace')
    setBusy(true)
    void geometry
      .setNamespace(namespace)
      .then(() => {
        toast.success('기본 Geometry namespace를 변경했습니다.')
        setDialog(openCreateAfterNamespace ? 'create' : null)
        setOpenCreateAfterNamespace(false)
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false))
  }

  const submitCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  const publish = (coordinate: GeometryModuleCoordinate) => {
    void geometry
      .requestPublish(coordinate)
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <>
      <GeometryWorkspace
        authenticated={authenticated}
        diagnostics={diagnostics}
        geometry={geometry}
        onChangeNamespace={() => {
          setOpenCreateAfterNamespace(false)
          setDialog('namespace')
        }}
        onCreate={openCreate}
        onEditAsNewVersion={(coordinate) => {
          void geometry
            .editAsNewVersion(coordinate)
            .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
        }}
        onManage={onOpenManager}
        onPublish={publish}
      />

      <Dialog
        open={dialog === 'namespace'}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null)
            setOpenCreateAfterNamespace(false)
          }
        }}
      >
        <DialogContent>
          <form className="grid w-[min(26rem,calc(100vw-4rem))] gap-4" onSubmit={submitNamespace}>
            <DialogHeader>
              <DialogTitle>기본 Geometry namespace</DialogTitle>
              <DialogDescription>
                새 Repository에만 적용됩니다. 기존 Repository, Published Geometry 좌표와 Experiment snapshot은 바뀌지
                않습니다.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              Namespace
              <Input
                autoFocus
                defaultValue={geometry.namespace ?? ''}
                maxLength={32}
                minLength={3}
                name="namespace"
                pattern="[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?"
                required
              />
            </label>
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
                생성 후 source import를 Monaco에서 직접 편집합니다. Experiment 연결 여부는 geometry.tsx의 import로
                결정됩니다.
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
                <Input defaultValue="notched-conductor" name="package" required />
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
                defaultValue={initialSource}
                name="source"
                required
                spellCheck={false}
              />
            </label>
            <DialogFooter>
              <Button onClick={() => setDialog(null)} type="button" variant="outline">
                취소
              </Button>
              <Button disabled={busy} type="submit">
                Draft 만들기
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={geometry.publishPlan !== null} onOpenChange={(open) => !open && geometry.setPublishPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <div className="grid max-h-[85dvh] gap-4 overflow-auto">
            <DialogHeader>
              <DialogTitle>Geometry 저장 계획</DialogTitle>
              <DialogDescription>
                source에서 도달하는 local dependency를 child-first 순서로 발행하고 모든 @local import를 exact
                Version으로 바꿉니다.
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-2 text-sm">
              {geometry.publishPlan?.value.steps.map((step, index) => (
                <li className="rounded-md border p-3" key={`${step.draftId}:${step.coordinate}`}>
                  <span className="font-medium">
                    {index + 1}. {step.coordinate}
                  </span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    exports: {step.exports.join(', ')} · imports: {step.imports.length}
                  </p>
                </li>
              ))}
            </ol>
            {geometry.publishPlan?.value.replacements.length ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                {geometry.publishPlan.value.replacements.map((item) => (
                  <p className="font-mono break-all" key={item.localCoordinate}>
                    {item.localCoordinate} → {item.coordinate}
                  </p>
                ))}
              </div>
            ) : null}
            <DialogFooter>
              <Button onClick={() => geometry.setPublishPlan(null)} variant="outline">
                취소
              </Button>
              <Button
                disabled={geometry.busy}
                onClick={() => {
                  void geometry
                    .confirmPublish()
                    .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
                }}
              >
                계획대로 저장
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
