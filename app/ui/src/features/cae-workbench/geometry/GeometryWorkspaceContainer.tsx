import { useEffect, useState, type FormEvent } from 'react'
import { toast } from 'sonner'
import { dbTables, getListRequest, type GeometryPackageRecord, type GeometryVersionRecord } from '@/api'
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
import type { CadDiagnostic, GeometryCoordinate } from '@/lib/cad'
import { GeometryUsageDialog } from './GeometryUsageDialog'
import { geometryComponentName } from './geometryUsage'
import { suggestGeometryRootAlias, type GeometryWorkspaceState } from './useGeometryWorkspaceState'
import { GeometryWorkspace } from './GeometryWorkspace'

const defaultGeometrySource = `import { type Geometry, type Vec3 } from '@caemble/core'

const NotchedConductor: Geometry<{
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

export default NotchedConductor
`

function value(form: FormData, name: string) {
  return String(form.get(name) ?? '').trim()
}

function sourceValue(form: FormData) {
  return String(form.get('source') ?? '')
}

export function GeometryWorkspaceContainer({
  diagnostics,
  geometry,
  onOpenExperimentSource,
  onOpenManager,
}: {
  diagnostics: readonly CadDiagnostic[]
  geometry: GeometryWorkspaceState
  onOpenExperimentSource: () => void
  onOpenManager: () => void
}) {
  const [dialog, setDialog] = useState<
    'namespace' | 'create' | 'add-root' | 'add-import' | 'connect-root' | 'usage' | null
  >(null)
  const [namespaceNext, setNamespaceNext] = useState<'create' | 'add-root' | 'add-import' | null>(null)
  const [packages, setPackages] = useState<GeometryPackageRecord[]>([])
  const [versions, setVersions] = useState<GeometryVersionRecord[]>([])
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<number | null>(null)
  const [selectedPackageId, setSelectedPackageId] = useState<number | null>(null)
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [importKind, setImportKind] = useState<'published' | 'draft'>('published')
  const [selectedLocalImport, setSelectedLocalImport] = useState<GeometryCoordinate | null>(null)
  const [connectCoordinate, setConnectCoordinate] = useState<GeometryCoordinate | null>(null)
  const [usage, setUsage] = useState<string | null>(null)
  const [pickerBusy, setPickerBusy] = useState(false)
  const refreshRepositories = geometry.refreshRepositories
  const ownRepositories = geometry.repositories

  const openProtectedDialog = (next: 'create' | 'add-root' | 'add-import') => {
    if (!geometry.namespace) {
      setNamespaceNext(next)
      setDialog('namespace')
      return
    }
    setDialog(next)
  }

  useEffect(() => {
    if (dialog !== 'create' && dialog !== 'add-root' && dialog !== 'add-import') return
    setPickerBusy(true)
    void refreshRepositories()
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }, [dialog, refreshRepositories])

  useEffect(() => {
    if (!selectedRepositoryId) {
      setPackages([])
      setSelectedPackageId(null)
      return
    }
    setPickerBusy(true)
    void dbTables.GeometryPackage.listRows({
      ...getListRequest('mine'),
      limit: null,
      filter: { repository_id: [selectedRepositoryId, selectedRepositoryId] },
      sort: ['name', 'asc'],
    })
      .then((response) => {
        setPackages(response.items)
        setSelectedPackageId(response.items[0]?.id ?? null)
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }, [selectedRepositoryId])

  useEffect(() => {
    if (!selectedPackageId) {
      setVersions([])
      setSelectedVersionId(null)
      return
    }
    setPickerBusy(true)
    void dbTables.GeometryVersion.listRows({
      ...getListRequest('mine'),
      limit: null,
      filter: { package_id: [selectedPackageId, selectedPackageId] },
      null_filter: { archived_at: 'is_null' },
      sort: [
        ['version_major', 'desc'],
        ['version_minor', 'desc'],
        ['version_patch', 'desc'],
      ],
    })
      .then((response) => {
        setVersions(response.items)
        setSelectedVersionId(response.items[0]?.id ?? null)
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }, [selectedPackageId])

  const handleNamespace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPickerBusy(true)
    void geometry
      .setNamespace(value(form, 'namespace'))
      .then(() => {
        setDialog(namespaceNext)
        setNamespaceNext(null)
        toast.success('Geometry namespace를 설정했습니다.')
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const repositoryId = Number(value(form, 'repositoryId')) || null
    setPickerBusy(true)
    void geometry
      .createDraft({
        repositoryId,
        repository: value(form, 'repository'),
        packageName: value(form, 'package'),
        version: value(form, 'version'),
        description: value(form, 'description'),
        source: sourceValue(form),
        rootAlias: null,
      })
      .then(() => setDialog(null))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }

  const handleAddRoot = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const alias = value(new FormData(event.currentTarget), 'alias')
    if (!selectedVersionId) {
      toast.error('추가할 exact Geometry version을 선택하세요.')
      return
    }
    setPickerBusy(true)
    void geometry
      .addRoot(selectedVersionId, alias)
      .then(() => {
        setUsage(alias)
        setDialog('usage')
      })
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }

  const handleConnectRoot = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!connectCoordinate) return
    const alias = value(new FormData(event.currentTarget), 'alias')
    try {
      geometry.connectRoot(connectCoordinate, alias)
      setUsage(alias)
      setConnectCoordinate(null)
      setDialog('usage')
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const handleAddImport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    if (!geometry.selectedCoordinate || !geometry.drafts[geometry.selectedCoordinate]) {
      toast.error('import를 추가할 Geometry draft를 선택하세요.')
      return
    }
    if (importKind === 'draft') {
      if (!selectedLocalImport) {
        toast.error('연결할 local draft를 선택하세요.')
        return
      }
      try {
        geometry.attachDraftImport(
          geometry.selectedCoordinate,
          selectedLocalImport,
          value(form, 'importName'),
          value(form, 'usage'),
        )
        setDialog(null)
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause))
      }
      return
    }
    if (!selectedVersionId) {
      toast.error('연결할 exact Geometry version을 선택하세요.')
      return
    }
    setPickerBusy(true)
    void geometry
      .addPublishedImport(
        geometry.selectedCoordinate,
        selectedVersionId,
        value(form, 'importName'),
        value(form, 'usage'),
      )
      .then(() => setDialog(null))
      .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPickerBusy(false))
  }

  const connectPackageName = connectCoordinate?.split('/').slice(-1)[0]?.split('@')[0] ?? 'geometry'
  const localImportDrafts = Object.values(geometry.drafts).filter(
    (draft) => draft.coordinate !== geometry.selectedCoordinate,
  )
  const importPackageName =
    importKind === 'draft'
      ? (selectedLocalImport?.split('/').slice(-1)[0]?.split('@')[0] ?? '')
      : (packages.find((item) => item.id === selectedPackageId)?.name ?? '')
  const suggestedConnectAlias = suggestGeometryRootAlias(
    connectPackageName,
    new Set([
      ...geometry.currentSnapshot.roots.map((root) => root.alias),
      ...Object.values(geometry.drafts).flatMap((draft) => (draft.rootAlias ? [draft.rootAlias] : [])),
    ]),
  )

  return (
    <>
      <GeometryWorkspace
        busy={geometry.busy}
        diagnostics={diagnostics}
        drafts={geometry.drafts}
        effectiveGraph={geometry.effectiveGraph}
        expandedPaths={geometry.expandedPaths}
        previewError={geometry.previewError}
        publishReady={geometry.publishReady}
        previewStale={geometry.previewStale}
        namespace={geometry.namespace}
        selectedCoordinate={geometry.selectedCoordinate}
        snapshot={geometry.currentSnapshot}
        onAddRoot={() => openProtectedDialog('add-root')}
        onAddImport={() => openProtectedDialog('add-import')}
        onBumpChange={geometry.setBump}
        onCreate={() => openProtectedDialog('create')}
        onCheckLatest={(coordinate) => {
          void geometry
            .checkLatestVersion(coordinate)
            .then((latest) => {
              if (!latest) toast.info('발행된 version이 없습니다.')
              else if (latest.coordinate === coordinate) toast.success(`${coordinate}가 최신 version입니다.`)
              else toast.info(`최신 version: ${latest.coordinate}`)
            })
            .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
        }}
        onConnectRoot={(coordinate) => {
          setConnectCoordinate(coordinate)
          setDialog('connect-root')
        }}
        onDescriptionChange={geometry.updateDescription}
        onDiscardDraft={geometry.discardDraft}
        onEditAsNewVersion={geometry.editAsNewVersion}
        onPublish={(coordinate, apply) => {
          void geometry
            .requestPublish(coordinate, apply)
            .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
        }}
        onRemoveRoot={(alias) => {
          try {
            geometry.removeRoot(alias)
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause))
          }
        }}
        onRenameRoot={(previousAlias, nextAlias) => {
          try {
            geometry.renameRootAlias(previousAlias, nextAlias)
            toast.success(`Root alias를 ${nextAlias.trim()}(으)로 변경했습니다.`)
          } catch (cause) {
            toast.error(cause instanceof Error ? cause.message : String(cause))
          }
        }}
        onShowUsage={(alias) => {
          setUsage(alias)
          setDialog('usage')
        }}
        onManageRepositories={onOpenManager}
        onChangeNamespace={() => {
          setNamespaceNext(null)
          setDialog('namespace')
        }}
        onSelect={geometry.setSelectedCoordinate}
        onSourceChange={geometry.updateSource}
        onTogglePath={geometry.togglePath}
      />

      <Dialog
        open={dialog === 'namespace'}
        onOpenChange={(open) => {
          if (open) return
          setNamespaceNext(null)
          setDialog(null)
        }}
      >
        <DialogContent>
          <form className="grid w-[min(26rem,calc(100vw-4rem))] gap-4" onSubmit={handleNamespace}>
            <DialogHeader>
              <DialogTitle>Geometry namespace 설정</DialogTitle>
              <DialogDescription>
                새 Repository의 기본 namespace입니다. 변경해도 기존 Published Geometry 좌표는 유지됩니다.
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
              <Button disabled={pickerBusy} type="submit">
                설정
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'create'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-2xl">
          <form
            className="grid max-h-[85dvh] w-[min(42rem,calc(100vw-4rem))] gap-4 overflow-auto"
            onSubmit={handleCreate}
          >
            <DialogHeader>
              <DialogTitle>새 Geometry draft</DialogTitle>
              <DialogDescription>
                publish 전까지 source는 이 Workbench와 IndexedDB에만 남습니다. Experiment 연결은 생성 후 별도로
                선택합니다.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-sm">
                기존 Repository
                <select className="h-9 rounded-md border bg-background px-3 text-sm" name="repositoryId">
                  <option value="">현재 namespace에 새 Repository</option>
                  {ownRepositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.namespace}/{repository.slug}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                새 Repository slug
                <Input defaultValue="common" name="repository" required />
              </label>
              <label className="grid gap-1 text-sm">
                Package name
                <Input defaultValue="new-geometry" name="package" required />
              </label>
              <label className="grid gap-1 text-sm">
                Initial version
                <Input defaultValue="0.1.0" name="version" required />
              </label>
              <label className="grid gap-1 text-sm">
                Description
                <Input name="description" />
              </label>
            </div>
            <label className="grid gap-1 text-sm">
              TSX source
              <textarea
                className="min-h-40 rounded-md border bg-background p-3 font-mono text-xs"
                defaultValue={defaultGeometrySource}
                name="source"
                required
              />
            </label>
            <DialogFooter>
              <Button disabled={pickerBusy} type="submit">
                Local draft 만들기
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'add-root'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-xl">
          <form className="grid w-[min(34rem,calc(100vw-4rem))] gap-4" onSubmit={handleAddRoot}>
            <DialogHeader>
              <DialogTitle>Published Geometry를 Experiment에서 사용</DialogTitle>
              <DialogDescription>
                내 repository의 exact version을 현재 Experiment snapshot에 고정합니다.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1 text-sm">
              Repository
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                onChange={(event) => setSelectedRepositoryId(Number(event.target.value) || null)}
                value={selectedRepositoryId ?? ''}
              >
                <option value="">선택</option>
                {ownRepositories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.namespace}/{item.slug}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Package
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                disabled={!selectedRepositoryId}
                onChange={(event) => setSelectedPackageId(Number(event.target.value) || null)}
                value={selectedPackageId ?? ''}
              >
                <option value="">선택</option>
                {packages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Exact version
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                disabled={!selectedPackageId}
                onChange={(event) => setSelectedVersionId(Number(event.target.value) || null)}
                value={selectedVersionId ?? ''}
              >
                <option value="">선택</option>
                {versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.version}
                  </option>
                ))}
              </select>
            </label>
            {selectedVersionId ? (
              <Button
                disabled={pickerBusy}
                onClick={() => {
                  if (!window.confirm('선택한 Geometry version을 archive할까요?')) return
                  setPickerBusy(true)
                  void geometry
                    .archiveVersion(selectedVersionId)
                    .then(async () => {
                      if (!selectedPackageId) return
                      const response = await dbTables.GeometryVersion.listRows({
                        ...getListRequest('mine'),
                        limit: null,
                        filter: { package_id: [selectedPackageId, selectedPackageId] },
                        null_filter: { archived_at: 'is_null' },
                        sort: [
                          ['version_major', 'desc'],
                          ['version_minor', 'desc'],
                          ['version_patch', 'desc'],
                        ],
                      })
                      setVersions(response.items)
                      setSelectedVersionId(response.items[0]?.id ?? null)
                      toast.success('Geometry version을 archive했습니다.')
                    })
                    .catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : String(cause)))
                    .finally(() => setPickerBusy(false))
                }}
                type="button"
                variant="outline"
              >
                선택한 version Archive
              </Button>
            ) : null}
            <label className="grid gap-1 text-sm">
              Experiment-local alias
              <Input defaultValue="geometry" name="alias" required />
            </label>
            <DialogFooter>
              <Button disabled={pickerBusy || !selectedVersionId} type="submit">
                연결하고 예시 보기
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'add-import'} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="w-fit min-w-[min(92vw,32rem)] sm:max-w-xl">
          <form className="space-y-4" onSubmit={handleAddImport}>
            <DialogHeader>
              <DialogTitle>Geometry import 추가</DialogTitle>
              <DialogDescription>
                선택한 draft source에 local draft 또는 Published exact version component 호출을 합성합니다.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1 text-sm">
              연결 대상
              <select
                className="h-9 rounded-md border bg-background px-2"
                onChange={(event) => setImportKind(event.target.value as 'published' | 'draft')}
                value={importKind}
              >
                <option value="published">Published exact version</option>
                <option disabled={!localImportDrafts.length} value="draft">
                  Local draft
                </option>
              </select>
            </label>
            {importKind === 'draft' ? (
              <label className="grid gap-1 text-sm">
                Local draft
                <select
                  className="h-9 rounded-md border bg-background px-2"
                  onChange={(event) =>
                    setSelectedLocalImport((event.target.value || null) as GeometryCoordinate | null)
                  }
                  value={selectedLocalImport ?? ''}
                >
                  <option value="">선택</option>
                  {localImportDrafts.map((draft) => (
                    <option key={draft.coordinate} value={draft.coordinate}>
                      {draft.coordinate}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label className="grid gap-1 text-sm">
                  Repository
                  <select
                    className="h-9 rounded-md border bg-background px-2"
                    onChange={(event) => setSelectedRepositoryId(Number(event.target.value) || null)}
                    value={selectedRepositoryId ?? ''}
                  >
                    <option value="">선택</option>
                    {ownRepositories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.namespace}/{item.slug}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Package
                  <select
                    className="h-9 rounded-md border bg-background px-2"
                    onChange={(event) => setSelectedPackageId(Number(event.target.value) || null)}
                    value={selectedPackageId ?? ''}
                  >
                    <option value="">선택</option>
                    {packages.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Exact version
                  <select
                    className="h-9 rounded-md border bg-background px-2"
                    onChange={(event) => setSelectedVersionId(Number(event.target.value) || null)}
                    value={selectedVersionId ?? ''}
                  >
                    <option value="">선택</option>
                    {versions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.version}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="grid gap-1 text-sm">
              Import component name
              <Input
                defaultValue={geometryComponentName(importPackageName)}
                key={`import-name:${importKind}:${importPackageName}`}
                name="importName"
                required
              />
            </label>
            <label className="grid gap-1 text-sm">
              Import usage JSX
              <Input
                defaultValue={`<${geometryComponentName(importPackageName)} id="geometry" />`}
                key={`import-usage:${importKind}:${importPackageName}`}
                name="usage"
                required
              />
            </label>
            <DialogFooter>
              <Button onClick={() => setDialog(null)} type="button" variant="outline">
                취소
              </Button>
              <Button
                disabled={pickerBusy || (importKind === 'published' ? !selectedVersionId : !selectedLocalImport)}
                type="submit"
              >
                Import 추가
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === 'connect-root'}
        onOpenChange={(open) => {
          if (open) return
          setConnectCoordinate(null)
          setDialog(null)
        }}
      >
        <DialogContent>
          <form className="grid w-[min(28rem,calc(100vw-4rem))] gap-4" onSubmit={handleConnectRoot}>
            <DialogHeader>
              <DialogTitle>Experiment에서 사용</DialogTitle>
              <DialogDescription>
                선택한 Geometry를 현재 Experiment에 연결합니다. PascalCase alias는 Experiment와 Task에서 바로 JSX
                component로 사용하며 JSX id와는 별개입니다.
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              Root alias
              <Input autoFocus defaultValue={suggestedConnectAlias} key={connectCoordinate} name="alias" required />
            </label>
            <DialogFooter>
              <Button onClick={() => setDialog(null)} type="button" variant="outline">
                취소
              </Button>
              <Button type="submit">연결하고 예시 보기</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <GeometryUsageDialog
        alias={usage ?? ''}
        onOpenChange={(open) => {
          if (open) return
          setUsage(null)
          setDialog(null)
        }}
        onOpenExperimentSource={onOpenExperimentSource}
        open={dialog === 'usage' && usage !== null}
      />

      <Dialog open={geometry.publishPlan !== null} onOpenChange={(open) => !open && geometry.setPublishPlan(null)}>
        <DialogContent className="sm:max-w-2xl">
          <div className="grid max-h-[85dvh] w-[min(42rem,calc(100vw-4rem))] gap-4 overflow-auto">
            <DialogHeader>
              <DialogTitle>Geometry publish plan</DialogTitle>
              <DialogDescription>
                서버가 source를 다시 분석하고 계산한 child-first 불변 version 계획입니다.
              </DialogDescription>
            </DialogHeader>
            <ol className="space-y-2 text-sm">
              {geometry.publishPlan?.value.steps.map((step, index) => (
                <li className="rounded-md border p-3" key={`${step.draftId}:${step.coordinate}`}>
                  <span className="font-medium">
                    {index + 1}. {step.coordinate}
                  </span>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {step.generated ? '상위 importer patch 자동 생성' : '선택한 draft'} · {step.imports.length} imports
                  </p>
                </li>
              ))}
            </ol>
            {geometry.publishPlan?.value.replacements.length ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
                {geometry.publishPlan.value.replacements.map((item) => (
                  <p key={`${item.alias}:${item.coordinate}`}>
                    Experiment root {item.alias} → {item.coordinate}
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
                계획대로 발행
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
