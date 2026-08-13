import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FileCode2,
  GitBranch,
  PanelRightOpen,
  Pencil,
  Plus,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react'
import { useMemo } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type {
  CadDiagnostic,
  EffectiveGeometryGraph,
  GeometryCoordinate,
  GeometrySnapshot,
  GeometrySnapshotModule,
} from '@/lib/cad'
import { cn } from '@/lib/utils'
import type { GeometryLocalDraft } from '../types'

type GeometryWorkspaceProps = Readonly<{
  busy: boolean
  diagnostics: readonly CadDiagnostic[]
  drafts: Readonly<Record<string, GeometryLocalDraft>>
  effectiveGraph: EffectiveGeometryGraph | null
  expandedPaths: readonly string[]
  previewError: string | null
  previewStale: boolean
  namespace: string | null
  selectedCoordinate: GeometryCoordinate | null
  snapshot: GeometrySnapshot | null
  onAddRoot: () => void
  onAddImport: () => void
  onCreate: () => void
  onCheckLatest: (coordinate: GeometryCoordinate) => void
  onBumpChange: (coordinate: GeometryCoordinate, bump: GeometryLocalDraft['bump']) => void
  onDiscardDraft: (coordinate: GeometryCoordinate) => void
  onEditAsNewVersion: (coordinate: GeometryCoordinate) => void
  onPublish: (coordinate: GeometryCoordinate, apply: boolean) => void
  onRemoveRoot: (alias: string) => void
  onManageRepositories: () => void
  onChangeNamespace: () => void
  onSelect: (coordinate: GeometryCoordinate) => void
  onSourceChange: (coordinate: GeometryCoordinate, source: string) => void
  onTogglePath: (path: string) => void
}>

function coordinateLabel(coordinate: string) {
  const parts = coordinate.split('/')
  return parts[parts.length - 1] ?? coordinate
}

function Metadata({
  draft,
  effectiveModule,
  effectiveImports,
  module,
  rootAliases,
}: {
  draft: GeometryLocalDraft | null
  effectiveModule: EffectiveGeometryGraph['modules'][number] | null
  effectiveImports: readonly GeometryCoordinate[] | null
  module: GeometrySnapshotModule | null
  rootAliases: readonly string[]
}) {
  if (!draft && !module && !effectiveModule) {
    return <p className="text-sm text-muted-foreground">Tree에서 Geometry를 선택하세요.</p>
  }
  const imports = effectiveImports ?? module?.imports.map((item) => item.coordinate) ?? []
  return (
    <div className="space-y-5 text-xs">
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Coordinate</h3>
        <p className="font-mono break-all text-muted-foreground">
          {draft?.coordinate ?? module?.coordinate ?? effectiveModule?.coordinate}
        </p>
      </section>
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Version</h3>
        <p className="text-muted-foreground">
          {draft
            ? `${draft.version} (${draft.bump})`
            : (module?.coordinate ?? effectiveModule?.coordinate)?.split('@')[1]}
        </p>
      </section>
      {rootAliases.length ? (
        <section className="space-y-1.5">
          <h3 className="font-semibold text-foreground">Root aliases</h3>
          <div className="flex flex-wrap gap-1">
            {rootAliases.map((alias) => (
              <Badge className="rounded-sm bg-muted" key={alias}>
                {alias}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Description</h3>
        <p className="whitespace-pre-wrap text-muted-foreground">
          {draft?.description || module?.description || (effectiveModule ? 'Preview staging' : '설명 없음')}
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-foreground">Exact imports</h3>
        {imports.length ? (
          <ul className="space-y-2">
            {imports.map((coordinate) => (
              <li className="rounded border bg-muted/25 p-2 font-mono break-all" key={coordinate}>
                {coordinate}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Import 없음</p>
        )}
        {draft ? (
          <p className="text-muted-foreground">
            import 추가·교체·제거는 TSX source의 exact coordinate import를 편집해 수행합니다.
          </p>
        ) : null}
      </section>
    </div>
  )
}

export function GeometryWorkspace(props: GeometryWorkspaceProps) {
  const modules = useMemo(
    () => new Map((props.snapshot?.modules ?? []).map((module) => [module.coordinate, module])),
    [props.snapshot?.modules],
  )
  const occurrenceCounts = useMemo(() => {
    const counts = new Map<string, number>()
    const effectiveModules = new Map(props.effectiveGraph?.modules.map((module) => [module.coordinate, module]))
    const visit = (coordinate: GeometryCoordinate) => {
      const current = counts.get(coordinate) ?? 0
      if (current >= 2) return
      counts.set(coordinate, current + 1)
      const effective = effectiveModules.get(coordinate)
      if (effective) effective.imports.forEach(visit)
      else modules.get(coordinate)?.imports.forEach((item) => visit(item.coordinate))
    }
    ;(props.effectiveGraph?.roots ?? props.snapshot?.roots ?? []).forEach((root) => visit(root.coordinate))
    return counts
  }, [modules, props.effectiveGraph, props.snapshot?.roots])
  const selectedModule = props.selectedCoordinate ? (modules.get(props.selectedCoordinate) ?? null) : null
  const selectedDraft = props.selectedCoordinate ? (props.drafts[props.selectedCoordinate] ?? null) : null
  const selectedEffectiveModule = props.selectedCoordinate
    ? (props.effectiveGraph?.modules.find((module) => module.coordinate === props.selectedCoordinate) ?? null)
    : null
  const diagnosticCoordinates = new Set(props.diagnostics.map((diagnostic) => diagnostic.file))
  const rootAliases = (props.effectiveGraph?.roots ?? props.snapshot?.roots ?? [])
    .filter((root) => root.coordinate === props.selectedCoordinate)
    .map((root) => root.alias)
  const selectedSource = selectedDraft?.source ?? selectedModule?.source ?? selectedEffectiveModule?.source ?? ''
  const renderedChildren = new Map<GeometryCoordinate, number>()

  const renderOccurrence = (coordinate: GeometryCoordinate, path: string, depth: number) => {
    const module = modules.get(coordinate)
    const draft = props.drafts[coordinate]
    const effective = props.effectiveGraph?.modules.find((item) => item.coordinate === coordinate)
    if (!module && !draft && !effective) return null
    const expanded = props.expandedPaths.includes(path)
    const children = effective?.imports ?? module?.imports.map((item) => item.coordinate) ?? []
    const previousRenderCount = renderedChildren.get(coordinate) ?? 0
    const traverseChildren = previousRenderCount < 2
    renderedChildren.set(coordinate, previousRenderCount + 1)
    const label = coordinateLabel(coordinate)
    return (
      <li key={path} role="treeitem" aria-expanded={children.length ? expanded : undefined}>
        <div
          className={cn(
            'group flex min-w-0 items-center gap-1 rounded-sm py-1 pr-1 text-xs hover:bg-accent',
            props.selectedCoordinate === coordinate && 'bg-accent text-accent-foreground',
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <button
            aria-label={expanded ? `${label} 접기` : `${label} 펼치기`}
            className={cn('grid size-5 shrink-0 place-items-center', !children.length && 'invisible')}
            onClick={() => props.onTogglePath(path)}
            type="button"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <button
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            onClick={() => props.onSelect(coordinate)}
            type="button"
          >
            <FileCode2 className="size-3.5 shrink-0" />
            <span className="truncate font-mono" title={coordinate}>
              {label}
            </span>
            {draft ? <Badge className="h-4 rounded-sm px-1 text-[9px]">draft</Badge> : null}
            {draft?.standalonePreview ? (
              <Badge className="h-4 rounded-sm bg-blue-100 px-1 text-[9px] text-blue-900">standalone</Badge>
            ) : null}
            {diagnosticCoordinates.has(coordinate) ||
            (draft && props.selectedCoordinate === coordinate && props.previewError) ? (
              <Badge className="text-destructive-foreground h-4 rounded-sm bg-destructive px-1 text-[9px]">error</Badge>
            ) : null}
            {(occurrenceCounts.get(coordinate) ?? 0) > 1 ? (
              <Badge className="h-4 rounded-sm bg-muted px-1 text-[9px]">shared</Badge>
            ) : null}
          </button>
        </div>
        {children.length && expanded && traverseChildren ? (
          <ul role="group">
            {children.map((item, index) => renderOccurrence(item, `${path}/${index}:${item}`, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  const effectiveCoordinates = new Set(props.effectiveGraph?.modules.map((module) => module.coordinate) ?? [])
  const unresolvedDrafts = Object.values(props.drafts).filter(
    (draft) => !modules.has(draft.coordinate) && !effectiveCoordinates.has(draft.coordinate),
  )
  const metadata = (
    <Metadata
      draft={selectedDraft}
      effectiveModule={selectedEffectiveModule}
      effectiveImports={selectedEffectiveModule?.imports ?? null}
      module={selectedModule}
      rootAliases={rootAliases}
    />
  )

  return (
    <section className="flex h-full min-h-[28rem] min-w-0 flex-col" aria-label="Geometry workspace">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1.5">
        <Button onClick={props.onAddRoot} size="sm" variant="outline">
          <Plus className="size-3.5" /> Root 추가
        </Button>
        <Button onClick={props.onCreate} size="sm" variant="outline">
          <CirclePlus className="size-3.5" /> 새 Geometry
        </Button>
        <Button onClick={props.onManageRepositories} size="sm" variant="ghost">
          Geometry Manager
        </Button>
        <Button onClick={props.onChangeNamespace} size="sm" variant="ghost">
          기본 namespace: <span className="font-mono">{props.namespace ?? '설정 안 됨'}</span>
        </Button>
        <span className="ml-auto flex items-center gap-2 text-xs">
          {props.previewStale ? (
            <Badge className="gap-1 rounded-sm bg-amber-500 text-white">
              <AlertTriangle className="size-3" /> Preview stale
            </Badge>
          ) : (
            <Badge className="rounded-sm bg-muted">Preview current</Badge>
          )}
          <Sheet>
            <SheetTrigger asChild>
              <Button aria-label="Geometry metadata 열기" className="2xl:hidden" size="icon" variant="ghost">
                <PanelRightOpen className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Geometry metadata</SheetTitle>
                <SheetDescription>선택한 module의 coordinate와 exact import 목록입니다.</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-auto pt-2">{metadata}</div>
            </SheetContent>
          </Sheet>
        </span>
      </header>
      {props.previewError ? (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          마지막 정상 프리뷰를 유지합니다. {props.previewError}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(11rem,28%)_minmax(0,1fr)] 2xl:grid-cols-[minmax(12rem,22%)_minmax(0,1fr)_minmax(13rem,24%)]">
        <aside className="min-h-0 overflow-auto border-r bg-muted/10 py-2" aria-label="Geometry dependency tree">
          {(props.effectiveGraph?.roots.length ?? props.snapshot?.roots.length) ? (
            <ul role="tree">
              {(props.effectiveGraph?.roots ?? props.snapshot?.roots ?? []).map((root) => (
                <li key={root.alias} className="mb-1" role="none">
                  <div className="flex items-center justify-between gap-1 px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                    <span className="truncate">Root · {root.alias}</span>
                    {props.snapshot?.roots.some((savedRoot) => savedRoot.alias === root.alias) ? (
                      <button
                        aria-label={`${root.alias} root 제거`}
                        className="rounded p-0.5 hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => props.onRemoveRoot(root.alias)}
                        type="button"
                      >
                        <X className="size-3" />
                      </button>
                    ) : null}
                  </div>
                  <ul role="tree">{renderOccurrence(root.coordinate, `root:${root.alias}`, 0)}</ul>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">등록된 root Geometry가 없습니다.</p>
          )}
          {unresolvedDrafts.length ? (
            <section className="mt-2 border-t pt-2">
              <h3 className="px-2 py-1 text-[10px] font-semibold tracking-wide text-amber-700 uppercase">
                Unresolved drafts
              </h3>
              {unresolvedDrafts.map((draft) => (
                <button
                  className={cn(
                    'flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent',
                    props.selectedCoordinate === draft.coordinate && 'bg-accent',
                  )}
                  key={draft.coordinate}
                  onClick={() => props.onSelect(draft.coordinate)}
                  type="button"
                >
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
                  <span className="truncate font-mono">{coordinateLabel(draft.coordinate)}</span>
                </button>
              ))}
            </section>
          ) : null}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs" title={props.selectedCoordinate ?? undefined}>
              {props.selectedCoordinate ?? 'Geometry를 선택하세요'}
            </span>
            {selectedModule && !selectedDraft ? (
              <>
                <Button
                  disabled={props.busy}
                  onClick={() => props.onCheckLatest(selectedModule.coordinate)}
                  size="sm"
                  variant="ghost"
                >
                  최신 version 확인
                </Button>
                <Button
                  disabled={props.busy}
                  onClick={() => props.onEditAsNewVersion(selectedModule.coordinate)}
                  size="sm"
                  variant="outline"
                >
                  <Pencil className="size-3.5" /> Edit as New Version
                </Button>
              </>
            ) : null}
            {selectedDraft ? (
              <>
                <Button disabled={props.busy} onClick={props.onAddImport} size="sm" variant="outline">
                  <Plus className="size-3.5" /> Import 추가
                </Button>
                {selectedDraft.baseGeometryVersionId ? (
                  <select
                    aria-label="Version bump"
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                    disabled={props.busy}
                    onChange={(event) =>
                      props.onBumpChange(selectedDraft.coordinate, event.target.value as GeometryLocalDraft['bump'])
                    }
                    value={selectedDraft.bump}
                  >
                    <option value="patch">patch</option>
                    <option value="minor">minor</option>
                    <option value="major">major</option>
                  </select>
                ) : null}
                <Button
                  disabled={props.busy}
                  onClick={() => props.onDiscardDraft(selectedDraft.coordinate)}
                  size="sm"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" /> 폐기
                </Button>
                <Button
                  disabled={props.busy}
                  onClick={() => props.onPublish(selectedDraft.coordinate, false)}
                  size="sm"
                  variant="outline"
                >
                  <Upload className="size-3.5" /> Publish only
                </Button>
                <Button
                  disabled={props.busy || selectedDraft.standalonePreview}
                  onClick={() => props.onPublish(selectedDraft.coordinate, true)}
                  size="sm"
                  title={selectedDraft.standalonePreview ? 'Standalone draft는 Publish only로 발행합니다.' : undefined}
                >
                  <GitBranch className="size-3.5" /> Publish &amp; Apply
                </Button>
              </>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {props.selectedCoordinate ? (
              <CadEditor
                diagnostics={props.diagnostics.filter((diagnostic) => diagnostic.file === props.selectedCoordinate)}
                disposeModelOnUnmount
                modelPath={`file:///caemble-geometry/${encodeURIComponent(props.selectedCoordinate)}.tsx`}
                onChange={(source) => props.onSourceChange(props.selectedCoordinate!, source)}
                readOnly={!selectedDraft || props.busy}
                value={selectedSource}
              />
            ) : (
              <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
                Tree에서 Geometry를 선택하거나 새 Geometry를 만드세요.
              </div>
            )}
          </div>
        </div>
        <aside
          className="hidden min-h-0 overflow-auto border-l bg-muted/10 p-4 2xl:block"
          aria-label="Geometry metadata"
        >
          {metadata}
        </aside>
      </div>
    </section>
  )
}
