import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CirclePlus,
  FileCode2,
  PanelRightOpen,
  Pencil,
  RotateCcw,
  Upload,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import CadEditor from '@/features/viewer/editor/CadEditor'
import type { CadEditorAuthoringState } from '@/features/viewer/editor/CadEditor'
import {
  analyzeGeometrySource,
  geometryExportAtOffset,
  type CadDiagnostic,
  type GeometryModuleCoordinate,
} from '@/lib/cad'
import { cn } from '@/lib/utils'
import type { GeometryLocalDraft } from '../types'
import type { GeometryWorkspaceState } from './useGeometryWorkspaceState'

type Occurrence = Readonly<{
  parent: 'geometry.tsx' | GeometryModuleCoordinate
  alias: string
  coordinate: GeometryModuleCoordinate
}>

type GeometryWorkspaceProps = Readonly<{
  authenticated: boolean
  diagnostics: readonly CadDiagnostic[]
  geometry: GeometryWorkspaceState
  onChangeNamespace: () => void
  onCreate: () => void
  onEditAsNewVersion: (coordinate: GeometryModuleCoordinate) => void
  onManage: () => void
  onPublish: (coordinate: GeometryModuleCoordinate) => void
  onAuthoringStateChange?: (state: CadEditorAuthoringState | null) => void
}>

function coordinateLabel(coordinate: string) {
  const parts = coordinate.split('/')
  return parts[parts.length - 1] ?? coordinate
}

function safeAnalysis(source: string, allowEmpty = false) {
  try {
    return analyzeGeometrySource(source, { allowEmpty, allowLocal: true })
  } catch {
    return null
  }
}

function Metadata({
  draft,
  module,
  onDescriptionChange,
  onBumpChange,
}: {
  draft: GeometryLocalDraft | null
  module: NonNullable<GeometryWorkspaceState['effectiveGraph']>['modules'][number] | null
  onDescriptionChange: (value: string) => void
  onBumpChange: (value: GeometryLocalDraft['bump']) => void
}) {
  if (!draft && !module)
    return <p className="text-sm text-muted-foreground">Tree에서 파일이나 Geometry를 선택하세요.</p>
  const analysis = safeAnalysis(draft?.source ?? module?.source ?? '')
  return (
    <div className="space-y-5 text-xs">
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Coordinate</h3>
        <p className="font-mono break-all text-muted-foreground">{draft?.coordinate ?? module?.coordinate}</p>
      </section>
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Named exports</h3>
        <div className="flex flex-wrap gap-1">
          {(analysis?.exports ?? []).map((item) => (
            <Badge className="rounded-sm" key={item.name}>
              {item.name}
            </Badge>
          ))}
          {!analysis?.exports.length ? (
            <span className="text-muted-foreground">분석 가능한 export가 없습니다.</span>
          ) : null}
        </div>
      </section>
      <section className="space-y-2">
        <h3 className="font-semibold text-foreground">Imports from source</h3>
        {analysis?.imports.length ? (
          <ul className="space-y-2">
            {analysis.imports.map((item) => (
              <li
                className="rounded border bg-muted/25 p-2"
                key={`${item.alias}:${item.coordinate}:${item.exportName}`}
              >
                <p className="font-mono font-semibold">{item.alias}</p>
                <p className="font-mono break-all text-muted-foreground">
                  {item.exportName} · {item.coordinate}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Import가 없습니다.</p>
        )}
        <p className="text-muted-foreground">
          Import 관계는 TSX source에서만 편집하며 Tree와 preview가 자동 갱신됩니다.
        </p>
      </section>
      <section className="space-y-1.5">
        <h3 className="font-semibold text-foreground">Description</h3>
        {draft ? (
          <textarea
            aria-label="Geometry description"
            className="min-h-20 w-full rounded-md border bg-background p-2 text-xs"
            maxLength={2_000}
            onChange={(event) => onDescriptionChange(event.target.value)}
            value={draft.description}
          />
        ) : (
          <p className="whitespace-pre-wrap text-muted-foreground">Published Version의 설명은 읽기 전용입니다.</p>
        )}
      </section>
      {draft?.baseGeometryVersionId ? (
        <label className="grid gap-1.5">
          Version bump
          <select
            className="h-8 rounded-md border bg-background px-2"
            onChange={(event) => onBumpChange(event.target.value as GeometryLocalDraft['bump'])}
            value={draft.bump}
          >
            <option value="patch">patch</option>
            <option value="minor">minor</option>
            <option value="major">major</option>
          </select>
        </label>
      ) : null}
    </div>
  )
}

export function GeometryWorkspace({
  authenticated,
  diagnostics,
  geometry,
  onChangeNamespace,
  onCreate,
  onEditAsNewVersion,
  onManage,
  onPublish,
  onAuthoringStateChange,
}: GeometryWorkspaceProps) {
  const modules = useMemo(
    () => new Map(geometry.effectiveGraph?.modules.map((module) => [module.coordinate, module]) ?? []),
    [geometry.effectiveGraph?.modules],
  )
  const selectedDraft =
    geometry.selectedCoordinate && geometry.selectedCoordinate !== 'geometry.tsx'
      ? (geometry.drafts[geometry.selectedCoordinate] ?? null)
      : null
  const selectedModule =
    geometry.selectedCoordinate && geometry.selectedCoordinate !== 'geometry.tsx'
      ? (modules.get(geometry.selectedCoordinate) ?? null)
      : null
  const selectedSource =
    geometry.selectedCoordinate === 'geometry.tsx'
      ? geometry.entrySource
      : (selectedDraft?.source ?? selectedModule?.source ?? '')
  const selectedAnalysis = useMemo(
    () => safeAnalysis(selectedSource, geometry.selectedCoordinate === 'geometry.tsx'),
    [geometry.selectedCoordinate, selectedSource],
  )
  const [cursor, setCursor] = useState<Readonly<{
    coordinate: GeometryModuleCoordinate | 'geometry.tsx'
    offset: number
  }> | null>(null)
  const entryAnalysis = safeAnalysis(geometry.entrySource, true)
  const reachable = new Set(geometry.effectiveGraph?.modules.map((module) => module.coordinate) ?? [])
  const standaloneDrafts = Object.values(geometry.drafts).filter((draft) => !reachable.has(draft.coordinate))

  useEffect(() => {
    if (!cursor || cursor.coordinate !== geometry.selectedCoordinate || !selectedAnalysis) return
    const nextExport = geometryExportAtOffset(selectedAnalysis, cursor.offset, geometry.selectedExport)
    if (nextExport && nextExport !== geometry.selectedExport) geometry.setSelectedExport(nextExport)
  }, [cursor, geometry, selectedAnalysis])

  const renderOccurrence = (
    imported: Readonly<{ exportName: string; alias: string; coordinate: GeometryModuleCoordinate }>,
    parent: 'geometry.tsx' | GeometryModuleCoordinate,
    path: readonly Occurrence[],
    depth: number,
  ): React.ReactNode => {
    const edge: Occurrence = { parent, alias: imported.alias, coordinate: imported.coordinate }
    const nextPath = [...path, edge]
    const pathKey = nextPath.map((item) => `${item.alias}:${item.coordinate}`).join('/')
    const module = modules.get(imported.coordinate)
    const children = module?.imports ?? []
    const expanded = geometry.expandedPaths.includes(pathKey)
    const selected =
      geometry.selectedCoordinate === imported.coordinate &&
      geometry.selectedPath.map((item) => `${item.alias}:${item.coordinate}`).join('/') === pathKey
    return (
      <li aria-expanded={children.length ? expanded : undefined} key={pathKey} role="treeitem">
        <div
          className={cn(
            'flex min-w-0 items-center gap-1 rounded py-1 pr-1 text-xs hover:bg-accent',
            selected && 'bg-accent',
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <button
            aria-label={expanded ? `${imported.alias} 접기` : `${imported.alias} 펼치기`}
            className={cn('grid size-5 shrink-0 place-items-center', !children.length && 'invisible')}
            onClick={() => geometry.togglePath(pathKey)}
            type="button"
          >
            {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
          <button
            className="min-w-0 flex-1 text-left"
            onClick={() => geometry.selectOccurrence(imported.coordinate, nextPath, imported.exportName)}
            type="button"
          >
            <span className="block truncate font-mono font-semibold">{imported.alias}</span>
            <span className="block truncate text-[10px] text-muted-foreground" title={imported.coordinate}>
              {imported.exportName} · {coordinateLabel(imported.coordinate)}
            </span>
          </button>
          {geometry.drafts[imported.coordinate] ? (
            <Badge className="h-4 rounded-sm px-1 text-[9px]">local</Badge>
          ) : null}
        </div>
        {expanded && children.length ? (
          <ul role="group">
            {children.map((child) => renderOccurrence(child, imported.coordinate, nextPath, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  const metadata = (
    <Metadata
      draft={selectedDraft}
      module={selectedModule}
      onBumpChange={(value) => {
        if (selectedDraft) geometry.setBump(selectedDraft.coordinate, value)
      }}
      onDescriptionChange={(value) => {
        if (selectedDraft) geometry.updateDescription(selectedDraft.coordinate, value)
      }}
    />
  )

  return (
    <section aria-label="Geometry workspace" className="flex h-full min-h-[28rem] min-w-0 flex-col">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-2 py-1.5">
        <Button onClick={onCreate} size="sm" variant="outline">
          <CirclePlus className="size-3.5" /> 새 Geometry
        </Button>
        <Button
          disabled={!authenticated}
          onClick={onManage}
          size="sm"
          variant="ghost"
          title={!authenticated ? '로그인 후 사용할 수 있습니다.' : undefined}
        >
          Geometry Manager
        </Button>
        <Button
          disabled={!authenticated}
          onClick={onChangeNamespace}
          size="sm"
          variant="ghost"
          title={!authenticated ? '로컬 작업은 local namespace를 사용합니다.' : undefined}
        >
          기본 namespace: <span className="font-mono">{geometry.namespace ?? '설정 필요'}</span>
        </Button>
        <span className="ml-auto flex items-center gap-2 text-xs">
          {geometry.previewStale ? (
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
                <SheetDescription>Named exports와 source에서 파생된 import 관계입니다.</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-auto pt-2">{metadata}</div>
            </SheetContent>
          </Sheet>
        </span>
      </header>
      {geometry.graphError || geometry.previewError ? (
        <div className="shrink-0 border-b border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="alert">
          마지막 정상 Tree와 Viewer를 유지합니다. {geometry.graphError ?? geometry.previewError}
        </div>
      ) : null}
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,28%)_minmax(0,1fr)] 2xl:grid-cols-[minmax(13rem,22%)_minmax(0,1fr)_minmax(14rem,24%)]">
        <aside aria-label="Geometry dependency tree" className="min-h-0 overflow-auto border-r bg-muted/10 py-2">
          <button
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent',
              geometry.selectedCoordinate === 'geometry.tsx' && 'bg-accent',
            )}
            onClick={() => geometry.selectOccurrence('geometry.tsx')}
            type="button"
          >
            <FileCode2 className="size-4" /> <span className="font-mono font-semibold">geometry.tsx</span>
          </button>
          {entryAnalysis?.exports.length ? (
            <div className="px-7 pb-1 text-[10px] text-muted-foreground">
              exports: {entryAnalysis.exports.map((item) => item.name).join(', ')}
            </div>
          ) : null}
          {geometry.effectiveGraph?.entryImports.length ? (
            <ul role="tree">
              {geometry.effectiveGraph.entryImports.map((item) => renderOccurrence(item, 'geometry.tsx', [], 0))}
            </ul>
          ) : (
            <p className="px-3 py-5 text-center text-xs text-muted-foreground">
              geometry.tsx에 import된 Geometry가 없습니다.
            </p>
          )}
          {standaloneDrafts.length ? (
            <section className="mt-2 border-t pt-2">
              <h3 className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase">
                Standalone local drafts
              </h3>
              {standaloneDrafts.map((draft) => (
                <button
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent',
                    geometry.selectedCoordinate === draft.coordinate && 'bg-accent',
                  )}
                  key={draft.coordinate}
                  onClick={() => geometry.selectOccurrence(draft.coordinate)}
                  type="button"
                >
                  <FileCode2 className="size-3.5" />{' '}
                  <span className="truncate font-mono">{coordinateLabel(draft.coordinate)}</span>
                  <Badge className="ml-auto h-4 rounded-sm px-1 text-[9px]">local</Badge>
                </button>
              ))}
            </section>
          ) : null}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">
              {geometry.selectedCoordinate ?? 'Geometry를 선택하세요.'}
            </span>
            {geometry.selectedExports.length > 1 ? (
              <select
                aria-label="Preview export"
                className="h-8 rounded-md border bg-background px-2 text-xs"
                onChange={(event) => geometry.setSelectedExport(event.target.value)}
                value={geometry.selectedExport ?? ''}
              >
                {geometry.selectedExports.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            ) : null}
            {selectedModule && !selectedDraft ? (
              <Button
                disabled={!authenticated || geometry.busy}
                onClick={() => onEditAsNewVersion(selectedModule.coordinate)}
                size="sm"
                variant="outline"
              >
                <Pencil className="size-3.5" /> Edit as New Version
              </Button>
            ) : null}
            {selectedDraft ? (
              <>
                <Button
                  disabled={geometry.busy}
                  onClick={() => geometry.discardDraft(selectedDraft.coordinate)}
                  size="sm"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" /> 되돌리기
                </Button>
                <Button
                  disabled={!authenticated || geometry.busy || !geometry.publishReady}
                  onClick={() => onPublish(selectedDraft.coordinate)}
                  size="sm"
                  title={
                    !authenticated
                      ? 'Geometry 저장은 로그인 후 사용할 수 있습니다.'
                      : !geometry.publishReady
                        ? '현재 graph의 preview가 성공해야 발행할 수 있습니다.'
                        : undefined
                  }
                >
                  <Upload className="size-3.5" /> Geometry 저장
                </Button>
              </>
            ) : null}
          </div>
          <div className="min-h-0 flex-1">
            {geometry.selectedCoordinate ? (
              <CadEditor
                diagnostics={diagnostics.filter(
                  (item) =>
                    item.file === geometry.selectedCoordinate ||
                    (geometry.selectedCoordinate === 'geometry.tsx' && item.file === 'geometry.tsx'),
                )}
                modelPath={
                  geometry.selectedCoordinate === 'geometry.tsx'
                    ? 'file:///caemble-workbench/geometry.tsx'
                    : `file:///geometries/${encodeURIComponent(geometry.selectedCoordinate)}.tsx`
                }
                onAuthoringStateChange={onAuthoringStateChange}
                onChange={geometry.updateSource}
                onCursorOffsetChange={(offset) => {
                  if (geometry.selectedCoordinate) setCursor({ coordinate: geometry.selectedCoordinate, offset })
                }}
                readOnly={geometry.busy}
                value={selectedSource}
              />
            ) : null}
          </div>
        </div>
        <aside
          aria-label="Geometry metadata"
          className="hidden min-h-0 overflow-auto border-l bg-muted/10 p-4 2xl:block"
        >
          {metadata}
        </aside>
      </div>
    </section>
  )
}
