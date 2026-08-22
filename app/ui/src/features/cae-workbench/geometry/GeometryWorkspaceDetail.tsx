import { Archive, ChevronLeft, ChevronRight, ExternalLink, RefreshCw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { GeometryPackageRecord, GeometryVersionRecord } from '@/api'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import { cn } from '@/lib/utils'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import { GeometryDraftVersionEditor, type GeometryDraftEditorState } from './GeometryDraftVersionEditor'
import type { GeometryDraftVersion } from '../types'

type ResolvedModule = {
  coordinate: string
  imports: readonly unknown[]
}

type DependentVersion = Readonly<{
  id: number
  package_id: number
  coordinate: string
}>

type ExperimentReference = Readonly<{
  id: number
  name: string
  description: string | null
  entry_alias: string | null
}>

export function GeometryWorkspaceDetail({
  authenticated,
  geometry,
  selectedDraft,
  selectedPackage,
  selectedPackageDraft,
  selectedVersion,
  selectedVersionId,
  versions,
  resolvedModules,
  dependents,
  dependentsTotal,
  experiments,
  experimentsTotal,
  experimentsRefetch,
  experimentSearch,
  setExperimentSearch,
  experimentPage,
  setExperimentPage,
  onSelectDraft,
  onSelectDependent,
  onSelectVersion,
  onDiscardDraft,
  onAuthoringStateChange,
  onOpenExperiment,
  onArchiveVersion,
  onDeleteVersion,
  archivePending,
  versionDeleteBlocked,
}: {
  authenticated: boolean
  geometry: GeometryDraftEditorState
  selectedDraft: GeometryDraftVersion | null
  selectedPackage: GeometryPackageRecord | null
  selectedPackageDraft: GeometryDraftVersion | null
  selectedVersion: GeometryVersionRecord | null
  selectedVersionId: number | null
  versions: readonly GeometryVersionRecord[]
  resolvedModules: readonly ResolvedModule[]
  dependents: readonly DependentVersion[]
  dependentsTotal: number
  experiments: readonly ExperimentReference[]
  experimentsTotal: number
  experimentsRefetch: () => Promise<unknown>
  experimentSearch: string
  setExperimentSearch: (value: string) => void
  experimentPage: number
  setExperimentPage: (value: number | ((current: number) => number)) => void
  onSelectDraft: (coordinate: GeometryModuleCoordinate) => void
  onSelectDependent: (packageId: number, versionId: number) => void
  onSelectVersion: (versionId: number, coordinate: GeometryModuleCoordinate) => void
  onDiscardDraft: (draft: GeometryDraftVersion) => void
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
  onOpenExperiment: (experimentId: number) => void | Promise<void>
  onArchiveVersion: () => void
  onDeleteVersion: () => void
  archivePending: boolean
  versionDeleteBlocked: boolean
}) {
  if (selectedDraft && !selectedPackage) {
    return (
      <div className="mx-auto max-w-6xl space-y-4">
        <header>
          <p className="font-mono text-xs text-muted-foreground">{selectedDraft.repository}</p>
          <h2 className="text-xl font-semibold">{selectedDraft.packageName}</h2>
        </header>
        <div className="grid gap-4">
          <Card className="overflow-hidden">
            <div className="border-b p-3 text-sm font-semibold">Versions</div>
            <div className="p-2">
              <button
                className="flex w-full items-center justify-between rounded bg-amber-50 px-2 py-2 text-left text-sm"
                type="button"
              >
                <span className="font-medium">Draft</span>
                <Badge>Draft Version</Badge>
              </button>
            </div>
          </Card>
          <Card className="min-w-0 overflow-hidden">
            <GeometryDraftVersionEditor
              authenticated={authenticated}
              draft={selectedDraft}
              geometry={geometry}
              onDiscard={onDiscardDraft}
              onAuthoringStateChange={onAuthoringStateChange}
            />
          </Card>
        </div>
      </div>
    )
  }

  if (!selectedPackage) {
    return (
      <div className="grid h-full place-items-center text-sm text-muted-foreground">Geometry Package를 선택하세요.</div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <p className="font-mono text-xs text-muted-foreground">
          {selectedPackage.namespace}/{selectedPackage.repository}
        </p>
        <h2 className="text-xl font-semibold">{selectedPackage.name}</h2>
      </header>

      <div className="grid gap-4">
        <Card className="overflow-hidden">
          <div className="border-b p-3 text-sm font-semibold">Versions</div>
          <div className="max-h-[34rem] overflow-auto p-2">
            {selectedPackageDraft ? (
              <button
                className="mb-1 flex w-full items-center justify-between rounded bg-amber-50 px-2 py-2 text-left text-sm hover:bg-amber-100"
                onClick={() => onSelectDraft(selectedPackageDraft.coordinate)}
                type="button"
              >
                <span className="font-medium">Draft</span>
                <Badge>Draft Version</Badge>
              </button>
            ) : null}
            {versions.map((version) => (
              <button
                className={cn(
                  'mb-1 flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-accent',
                  version.id === selectedVersionId && 'bg-accent',
                )}
                key={version.id}
                onClick={() => onSelectVersion(version.id, version.coordinate as GeometryModuleCoordinate)}
                type="button"
              >
                <span className="font-mono">v{version.version}</span>
                {version.archived_at ? <Badge className="bg-muted">Archived</Badge> : null}
              </button>
            ))}
            {!versions.length ? <p className="p-4 text-center text-xs text-muted-foreground">Version 없음</p> : null}
          </div>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          {selectedDraft ? (
            <GeometryDraftVersionEditor
              authenticated={authenticated}
              draft={selectedDraft}
              geometry={geometry}
              onDiscard={onDiscardDraft}
              onAuthoringStateChange={onAuthoringStateChange}
            />
          ) : !selectedVersion ? (
            <div className="grid h-48 place-items-center text-sm text-muted-foreground">Version을 선택하세요.</div>
          ) : (
            <Tabs defaultValue="source">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs" title={selectedVersion.coordinate}>
                    {selectedVersion.coordinate}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    source {selectedVersion.source_hash.slice(0, 12)} · module{' '}
                    {selectedVersion.module_hash.slice(0, 12)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    disabled={Boolean(selectedVersion.archived_at) || archivePending}
                    onClick={onArchiveVersion}
                    size="sm"
                    variant="outline"
                  >
                    <Archive /> Archive
                  </Button>
                  <Button disabled={versionDeleteBlocked} onClick={onDeleteVersion} size="sm" variant="destructive">
                    <Trash2 /> 삭제
                  </Button>
                </div>
              </div>
              <TabsList className="m-3 mb-0">
                <TabsTrigger value="source">Source</TabsTrigger>
                <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
                <TabsTrigger value="references">References</TabsTrigger>
              </TabsList>
              <TabsContent className="m-0" value="source">
                {selectedPackageDraft ? (
                  <div className="border-t border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    이 Package에는 Draft Version이 있습니다. Published Version은 미리보기만 가능하며, Draft를 선택하거나
                    폐기한 뒤 편집할 수 있습니다.
                  </div>
                ) : null}
                <div className="h-[28rem] border-t">
                  <GeometrySourcePreview version={selectedVersion} onAuthoringStateChange={onAuthoringStateChange} />
                </div>
              </TabsContent>
              <TabsContent className="m-0 space-y-4 border-t p-4" value="dependencies">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <p className="text-xs font-semibold">Module format</p>
                    <p className="text-sm">v{selectedVersion.module_format_version}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold">CAD API</p>
                    <p className="text-sm">v{selectedVersion.cad_api_version}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold">Created</p>
                    <p className="text-sm">
                      {selectedVersion.created_at ? new Date(selectedVersion.created_at).toLocaleString() : '—'}
                    </p>
                  </div>
                </div>
                <section>
                  <h3 className="mb-2 text-sm font-semibold">Resolved dependency closure</h3>
                  <ul className="space-y-2">
                    {resolvedModules.map((module) => (
                      <li className="rounded border p-3" key={module.coordinate}>
                        <p className="font-mono text-xs break-all">{module.coordinate}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{module.imports.length} exact imports</p>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="mb-2 text-sm font-semibold">이 Version을 import하는 Geometry</h3>
                  {dependents.map((item) => (
                    <button
                      className="mb-2 flex w-full items-center justify-between rounded border p-3 text-left hover:bg-accent"
                      key={item.id}
                      onClick={() => onSelectDependent(item.package_id, item.id)}
                      type="button"
                    >
                      <span className="font-mono text-xs break-all">{item.coordinate}</span>
                      <ExternalLink className="size-4" />
                    </button>
                  ))}
                  {!dependentsTotal ? (
                    <p className="text-xs text-muted-foreground">Dependent Geometry가 없습니다.</p>
                  ) : null}
                </section>
              </TabsContent>
              <TabsContent className="m-0 space-y-3 border-t p-4" value="references">
                <div className="flex gap-2">
                  <Input
                    aria-label="참조 Experiment 검색"
                    onChange={(event) => setExperimentSearch(event.target.value)}
                    placeholder="Experiment 이름 또는 설명 검색"
                    value={experimentSearch}
                  />
                  <Button onClick={() => void experimentsRefetch()} size="icon" variant="outline">
                    <RefreshCw />
                  </Button>
                </div>
                {experiments.map((item) => (
                  <button
                    className="flex w-full items-center justify-between gap-3 rounded border p-3 text-left hover:bg-accent"
                    key={item.id}
                    onClick={() => void onOpenExperiment(item.id)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.name} · #{item.id}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{item.description || '설명 없음'}</p>
                    </div>
                    <Badge className={item.entry_alias ? 'bg-blue-100 text-blue-900' : 'bg-muted'}>
                      {item.entry_alias ? `Entry · ${item.entry_alias}` : 'Indirect'}
                    </Badge>
                  </button>
                ))}
                {!experimentsTotal ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">참조하는 Experiment가 없습니다.</p>
                ) : null}
                <div className="flex items-center justify-end gap-2 text-xs">
                  <Button
                    disabled={experimentPage === 0}
                    onClick={() => setExperimentPage((value) => value - 1)}
                    size="icon"
                    variant="ghost"
                  >
                    <ChevronLeft />
                  </Button>
                  <span>
                    {experimentPage + 1} / {Math.max(1, Math.ceil(experimentsTotal / 10))}
                  </span>
                  <Button
                    disabled={(experimentPage + 1) * 10 >= experimentsTotal}
                    onClick={() => setExperimentPage((value) => value + 1)}
                    size="icon"
                    variant="ghost"
                  >
                    <ChevronRight />
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          )}
        </Card>
      </div>
    </div>
  )
}

function GeometrySourcePreview({
  version,
  onAuthoringStateChange,
}: {
  version: GeometryVersionRecord
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}) {
  return (
    <CadEditor
      diagnostics={[]}
      modelPath={`file:///geometry-manager/${version.id}.tsx`}
      onAuthoringStateChange={onAuthoringStateChange}
      onChange={() => undefined}
      readOnly
      value={version.source}
    />
  )
}
