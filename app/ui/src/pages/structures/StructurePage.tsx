import type { ColumnDef } from '@tanstack/react-table'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Code2, Eye, GitBranch, LoaderCircle, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { dbTables, getListRequest, type StructureRecord, type UserData } from '@/api'
import { DataTable } from '@/components/DataTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/use-auth'
import { useCurrentCadSelection } from '@/features/viewer/current-cad-selection'
import { SaveDefinitionDialog, type DefinitionFormValues } from '@/features/viewer/persistence/SaveDefinitionDialog'
import { createDocumentMaterialResolver } from '@/features/viewer/persistence/resolveMaterials'
import { saveCadDefinition } from '@/features/viewer/persistence/saveDefinition'
import CadViewer from '@/features/viewer/viewer/CadViewer'
import { StructureExperimentViewer } from '@/features/viewer/workspace/StructureExperimentViewer'
import { useCadWorkspace } from '@/features/viewer/workspace/useCadWorkspace'
import { VarsControls } from '@/features/viewer/workspace/VarsControls'
import { cadSource, createCadSourceDocument, type CadDocumentType, type CadSourceDocument, type Vars } from '@/lib/cad'
import { defaultCode } from '@/lib/defaultCode'
import { readMeasurementReturnTo, updateMeasurementReturnTo } from '@/pages/measurements/measurement-return'

type StructureRow = StructureRecord & { id: number }

const defaultWorkspaceLeftPercent = 44

function positiveId(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function compareStructures(left: StructureRow, right: StructureRow) {
  const updatedDifference = Date.parse(right.updated_at ?? '') - Date.parse(left.updated_at ?? '')
  return Number.isNaN(updatedDifference) || updatedDifference === 0 ? right.id - left.id : updatedDifference
}

function canManageStructure(row: StructureRow, user: UserData | null) {
  return Boolean(user && (user.roles.includes('admin') || row.user_id === user.id))
}

function clampWorkspaceLeftPercent(percent: number, workspaceWidth: number) {
  const minimum = Math.max(25, (360 / workspaceWidth) * 100)
  const maximum = Math.min(75, ((workspaceWidth - 320) / workspaceWidth) * 100)
  return Math.min(maximum, Math.max(minimum, percent))
}

function LineageNode({
  canManage,
  childrenByParent,
  depth,
  onDelete,
  onNavigate,
  row,
  selectedId,
}: {
  canManage: (row: StructureRow) => boolean
  childrenByParent: ReadonlyMap<number, readonly StructureRow[]>
  depth: number
  onDelete: (row: StructureRow) => void
  onNavigate: (row: StructureRow) => void
  row: StructureRow
  selectedId: number
}) {
  const children = childrenByParent.get(row.id) ?? []
  return (
    <li>
      <div
        className={`flex items-center gap-2 border-b px-2 py-2 ${row.id === selectedId ? 'bg-orange-50' : 'hover:bg-muted/50'}`}
        style={{ paddingLeft: `${depth * 18 + 8}px` }}
      >
        <button className="min-w-0 flex-1 text-left" type="button" onClick={() => onNavigate(row)}>
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{row.name}</span>
            {depth === 0 ? <Badge>root</Badge> : null}
            {children.length === 0 ? <Badge>leaf</Badge> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {row.description || `Structure #${row.id}`}
          </span>
        </button>
        {canManage(row) ? (
          <Button
            aria-label={`${row.name} 삭제`}
            className="text-destructive hover:text-destructive"
            size="icon"
            title="Structure 삭제"
            variant="ghost"
            onClick={() => onDelete(row)}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
      {children.length > 0 ? (
        <ul>
          {children.map((child) => (
            <LineageNode
              canManage={canManage}
              childrenByParent={childrenByParent}
              depth={depth + 1}
              key={child.id}
              onDelete={onDelete}
              onNavigate={onNavigate}
              row={child}
              selectedId={selectedId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function StructureLineage({
  canManage,
  onDelete,
  onNavigate,
  rows,
  selected,
}: {
  canManage: (row: StructureRow) => boolean
  onDelete: (row: StructureRow) => void
  onNavigate: (row: StructureRow) => void
  rows: readonly StructureRow[]
  selected: StructureRow
}) {
  const { childrenByParent, root } = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]))
    const children = new Map<number, StructureRow[]>()
    rows.forEach((row) => {
      if (row.parent_id == null || !byId.has(row.parent_id)) return
      const siblings = children.get(row.parent_id) ?? []
      siblings.push(row)
      children.set(row.parent_id, siblings)
    })
    children.forEach((siblings) => siblings.sort(compareStructures))

    let lineageRoot = selected
    const visited = new Set<number>()
    while (lineageRoot.parent_id != null && byId.has(lineageRoot.parent_id) && !visited.has(lineageRoot.id)) {
      visited.add(lineageRoot.id)
      lineageRoot = byId.get(lineageRoot.parent_id)!
    }
    return { childrenByParent: children, root: lineageRoot }
  }, [rows, selected])

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="border-b bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch className="size-4 text-primary" />
          전체 계보
        </div>
        <p className="mt-1 text-xs text-muted-foreground">보이는 root부터 모든 후손을 표시합니다.</p>
      </div>
      <ul>
        <LineageNode
          canManage={canManage}
          childrenByParent={childrenByParent}
          depth={0}
          onDelete={onDelete}
          onNavigate={onNavigate}
          row={root}
          selectedId={selected.id}
        />
      </ul>
    </div>
  )
}

export function StructurePage() {
  const auth = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const {
    currentExperimentId,
    currentStructureId: selectedStructureId,
    setCurrentExperimentId,
    setCurrentStructureId: setSelectedStructureId,
  } = useCurrentCadSelection()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [editorOpen, setEditorOpen] = useState(false)
  const [structure, setStructure] = useState<CadSourceDocument | null>(null)
  const [structureVars, setStructureVars] = useState<Readonly<Vars> | undefined>()
  const [savedStructureCode, setSavedStructureCode] = useState<string | null>(null)
  const [metadataTarget, setMetadataTarget] = useState<StructureRow | null>(null)
  const [metadataName, setMetadataName] = useState('')
  const [metadataDescription, setMetadataDescription] = useState('')
  const [saveMode, setSaveMode] = useState<'create' | 'root' | 'save' | null>(null)
  const [pendingNavigation, setPendingNavigation] = useState<StructureRow | null>(null)
  const [pendingEditorOpen, setPendingEditorOpen] = useState(false)
  const [pendingCreate, setPendingCreate] = useState(false)
  const [pendingReturn, setPendingReturn] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<StructureRow | null>(null)
  const [workspaceLeftPercent, setWorkspaceLeftPercent] = useState(defaultWorkspaceLeftPercent)
  const initializedFromUrl = useRef(false)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const [measurementReturnTo] = useState(() => readMeasurementReturnTo(location.state))

  const visibleRequest = useMemo(() => ({ ...getListRequest('visible'), limit: null }), [])
  const structuresQuery = useQuery({
    queryKey: ['structures', 'visible'],
    queryFn: () => dbTables.Structure.listRows(visibleRequest),
  })
  const currentExperimentQuery = useQuery({
    queryKey: ['experiments', 'visible', currentExperimentId],
    queryFn: async () => {
      if (currentExperimentId === null) return null
      return (await dbTables.Experiment.listRows(getListRequest('visible', [currentExperimentId]))).items[0] ?? null
    },
    enabled: currentExperimentId !== null,
  })
  const rows = useMemo(
    () =>
      (structuresQuery.data?.items ?? [])
        .filter((row): row is StructureRow => row.id !== undefined)
        .sort(compareStructures),
    [structuresQuery.data?.items],
  )
  const selectedStructure = rows.find((row) => row.id === selectedStructureId) ?? null
  const currentExperiment = useMemo(
    () =>
      currentExperimentQuery.data
        ? createCadSourceDocument('experiment', currentExperimentQuery.data.source_bundle)
        : null,
    [currentExperimentQuery.data],
  )
  const canManage = useCallback((row: StructureRow) => canManageStructure(row, auth.user), [auth.user])
  const selectedManageable = Boolean(selectedStructure && canManage(selectedStructure))
  const dirty = Boolean(structure && (savedStructureCode === null || cadSource(structure) !== savedStructureCode))

  const leafRows = useMemo(() => {
    const visibleIds = new Set(rows.map((row) => row.id))
    const parentIds = new Set(
      rows.flatMap((row) => (row.parent_id != null && visibleIds.has(row.parent_id) ? [row.parent_id] : [])),
    )
    const needle = query.trim().toLocaleLowerCase()
    return rows.filter(
      (row) =>
        !parentIds.has(row.id) &&
        (!needle || [row.name, row.description ?? ''].some((value) => value.toLocaleLowerCase().includes(needle))),
    )
  }, [query, rows])

  const updateDeepLink = useCallback(
    (id: number | 'new' | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          if (id) next.set('structure', String(id))
          else next.delete('structure')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const updateEditorOpen = useCallback(
    (open: boolean) => {
      setEditorOpen(open)
      if (!measurementReturnTo && !searchParams.has('mode')) return
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.set('mode', open ? 'code' : 'list')
          return next
        },
        { replace: true },
      )
    },
    [measurementReturnTo, searchParams, setSearchParams],
  )

  const applyStructure = useCallback(
    (row: StructureRow) => {
      setStructure(createCadSourceDocument('structure', row.code))
      setStructureVars(undefined)
      setSelectedStructureId(row.id)
      setSavedStructureCode(row.code)
      updateDeepLink(row.id)
    },
    [setSelectedStructureId, updateDeepLink],
  )

  const clearStructure = useCallback(() => {
    setStructure(null)
    setStructureVars(undefined)
    setSelectedStructureId(null)
    setSavedStructureCode(null)
    updateEditorOpen(false)
    updateDeepLink(null)
  }, [setSelectedStructureId, updateDeepLink, updateEditorOpen])

  const startNewStructure = useCallback(() => {
    setStructure(createCadSourceDocument('structure', defaultCode))
    setStructureVars(undefined)
    setSelectedStructureId(null)
    setSavedStructureCode(null)
    updateEditorOpen(true)
    updateDeepLink('new')
  }, [setSelectedStructureId, updateDeepLink, updateEditorOpen])

  useEffect(() => {
    if (initializedFromUrl.current || !structuresQuery.isSuccess) return
    initializedFromUrl.current = true
    const rawId = searchParams.get('structure')
    if (rawId === 'new') {
      startNewStructure()
      return
    }
    const id = rawId === null ? selectedStructureId : positiveId(rawId)
    if (id === null) {
      if (rawId !== null) {
        toast.error('Structure를 찾을 수 없습니다.')
        setSelectedStructureId(null)
        updateDeepLink(null)
      }
      return
    }
    const row = rows.find((item) => item.id === id)
    if (!row) {
      toast.error('Structure를 찾을 수 없습니다.')
      setSelectedStructureId(null)
      updateDeepLink(null)
      return
    }
    applyStructure(row)
    updateEditorOpen(searchParams.get('mode') === 'code')
  }, [
    applyStructure,
    rows,
    searchParams,
    selectedStructureId,
    setSelectedStructureId,
    startNewStructure,
    structuresQuery.isSuccess,
    updateDeepLink,
    updateEditorOpen,
  ])

  useEffect(() => {
    if (currentExperimentId === null) return
    if (currentExperimentQuery.isSuccess && currentExperimentQuery.data === null) {
      toast.error('현재 Experiment를 찾을 수 없습니다.')
      setCurrentExperimentId(null)
    } else if (currentExperimentQuery.isError) {
      toast.error('현재 Experiment를 불러오지 못했습니다.')
    }
  }, [
    currentExperimentId,
    currentExperimentQuery.data,
    currentExperimentQuery.isError,
    currentExperimentQuery.isSuccess,
    setCurrentExperimentId,
  ])

  const resolveMaterials = useMemo(
    () => createDocumentMaterialResolver(null),
    // These values intentionally define the lifetime of the session-local Material lookup cache.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      auth.user,
      currentExperiment ? cadSource(currentExperiment) : null,
      currentExperimentId,
      selectedStructureId,
      structure ? cadSource(structure) : null,
    ],
  )
  const handleStructureChange = useCallback((document: CadSourceDocument) => {
    setStructure(document)
    setStructureVars(undefined)
  }, [])
  const { experimentDocument, simulation, structureDocument } = useCadWorkspace(
    structure,
    currentExperiment,
    auth.isAuthenticated ? handleStructureChange : undefined,
    undefined,
    structureVars,
    undefined,
    resolveMaterials,
    'fast-reroll',
    auth.isAuthenticated,
  )

  const invalidateStructures = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['structures'] }),
      queryClient.invalidateQueries({ queryKey: ['work', 'structures'] }),
    ])
  }, [queryClient])

  const metadataMutation = useMutation({
    mutationFn: ({ description, name, row }: { description: string; name: string; row: StructureRow }) =>
      dbTables.Structure.upsertRow([
        {
          id: row.id,
          user_id: row.user_id,
          parent_id: row.parent_id,
          name: name.trim(),
          description: description.trim() || null,
          code: row.code,
        },
      ]),
    onSuccess: async () => {
      setMetadataTarget(null)
      await invalidateStructures()
      toast.success('Structure 정보를 저장했습니다.')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Structure 정보를 저장하지 못했습니다.'),
  })

  const definitionMutation = useMutation({
    mutationFn: ({ forceRoot, values }: { forceRoot: boolean; values: DefinitionFormValues }) => {
      if (!structure) throw new Error('저장할 Structure source가 없습니다.')
      if (!auth.isAuthenticated) throw new Error('로그인이 필요합니다.')
      if (!forceRoot && (!selectedStructure || !canManage(selectedStructure))) {
        throw new Error('이 Structure를 수정할 권한이 없습니다.')
      }
      return saveCadDefinition({
        document: structure,
        forceRoot,
        kind: 'structure',
        savedCode: savedStructureCode,
        selectedId: selectedStructureId,
        values,
      })
    },
    onSuccess: async ({ action, code, id }, { forceRoot }) => {
      setSelectedStructureId(id)
      setSavedStructureCode(code ?? null)
      updateDeepLink(id)
      setSaveMode(null)
      await invalidateStructures()
      toast.success(
        forceRoot
          ? '현재 Structure를 새 root로 저장했습니다.'
          : action === 'forked'
            ? '구조 변경을 새 child Structure로 저장했습니다.'
            : 'Structure를 저장했습니다.',
      )
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Structure를 저장하지 못했습니다.'),
  })

  const deleteMutation = useMutation({
    mutationFn: async (row: StructureRow) => {
      await dbTables.Structure.deleteRows([row.id])
      return row
    },
    onSuccess: async (deleted) => {
      const fallback =
        deleted.parent_id == null
          ? (rows.filter((row) => row.parent_id === deleted.id).sort(compareStructures)[0] ?? null)
          : (rows.find((row) => row.id === deleted.parent_id) ??
            rows.filter((row) => row.parent_id === deleted.id).sort(compareStructures)[0] ??
            null)
      setDeleteTarget(null)
      if (selectedStructureId === deleted.id) {
        if (fallback) applyStructure(fallback)
        else clearStructure()
      }
      await invalidateStructures()
      toast.success('Structure를 삭제하고 기존 child의 계보를 재연결했습니다.')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Structure를 삭제하지 못했습니다.'),
  })

  const requestNavigation = useCallback(
    (row: StructureRow, rerollWhenSelected: boolean) => {
      if (row.id === selectedStructureId) {
        if (rerollWhenSelected) structureDocument.handleReroll()
        return
      }
      if (dirty) {
        setPendingNavigation(row)
        return
      }
      applyStructure(row)
    },
    [applyStructure, dirty, selectedStructureId, structureDocument],
  )

  const requestNewStructure = useCallback(() => {
    if (dirty) {
      setPendingCreate(true)
      return
    }
    startNewStructure()
  }, [dirty, startNewStructure])

  const requestEditorOpen = useCallback(
    (row: StructureRow) => {
      if (row.id === selectedStructureId) {
        updateEditorOpen(true)
        return
      }
      if (dirty) {
        setPendingNavigation(row)
        setPendingEditorOpen(true)
        return
      }
      applyStructure(row)
      updateEditorOpen(true)
    },
    [applyStructure, dirty, selectedStructureId, updateEditorOpen],
  )

  const returnToMeasurement = useCallback(() => {
    if (!measurementReturnTo) return
    navigate(updateMeasurementReturnTo(measurementReturnTo, 'structure', selectedStructureId))
  }, [measurementReturnTo, navigate, selectedStructureId])

  const requestReturnToMeasurement = useCallback(() => {
    if (dirty) {
      setPendingReturn(true)
      return
    }
    returnToMeasurement()
  }, [dirty, returnToMeasurement])

  const openMetadata = useCallback((row: StructureRow) => {
    setMetadataTarget(row)
    setMetadataName(row.name)
    setMetadataDescription(row.description ?? '')
  }, [])

  const columns = useMemo<ColumnDef<StructureRow, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-40">
            <p className="font-medium">{row.original.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">Structure #{row.original.id}</p>
          </div>
        ),
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ row }) => (
          <p className="line-clamp-2 max-w-xl text-sm text-muted-foreground">{row.original.description || '—'}</p>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const editable = canManage(row.original)
          return (
            <div className="flex items-center justify-end gap-1">
              <Button
                aria-label={`${row.original.name} 코드 에디터 열기`}
                size="icon"
                title="코드 에디터 열기"
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation()
                  requestEditorOpen(row.original)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Code2 />
              </Button>
              <Button
                aria-label={`${row.original.name} ${editable ? '정보 편집' : '정보 보기'}`}
                size="icon"
                title={editable ? '이름과 설명 편집' : '이름과 설명 보기'}
                variant="ghost"
                onClick={(event) => {
                  event.stopPropagation()
                  openMetadata(row.original)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                {editable ? <Pencil /> : <Eye />}
              </Button>
            </div>
          )
        },
      },
    ],
    [canManage, openMetadata, requestEditorOpen],
  )

  const structureViewerDocument = useMemo(
    () =>
      structure
        ? {
            scene: structureDocument.scene,
            sceneHash: structureDocument.sceneHash,
            variables: structureDocument.variables,
          }
        : null,
    [structure, structureDocument.scene, structureDocument.sceneHash, structureDocument.variables],
  )
  const experimentViewerDocument = useMemo(
    () =>
      currentExperiment
        ? {
            scene: experimentDocument.scene,
            sceneHash: experimentDocument.sceneHash,
            taskScenes: experimentDocument.taskScenes,
            taskSceneHashes: experimentDocument.taskSceneHashes,
            variables: experimentDocument.variables,
          }
        : null,
    [
      currentExperiment,
      experimentDocument.scene,
      experimentDocument.sceneHash,
      experimentDocument.taskSceneHashes,
      experimentDocument.taskScenes,
      experimentDocument.variables,
    ],
  )
  const handleRenderStart = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderStart()
      if (sources.includes('experiment')) experimentDocument.handleRenderStart()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderEnd = useCallback(
    (sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderEnd()
      if (sources.includes('experiment')) experimentDocument.handleRenderEnd()
    },
    [experimentDocument, structureDocument],
  )
  const handleRenderError = useCallback(
    (message: string, sources: readonly CadDocumentType[]) => {
      if (sources.includes('structure')) structureDocument.handleRenderError(message)
      if (sources.includes('experiment')) experimentDocument.handleRenderError(message)
    },
    [experimentDocument, structureDocument],
  )

  const saveDefaults = {
    name: selectedStructure?.name ?? '새 Structure',
    description: selectedStructure?.description ?? '',
  }
  const metadataEditable = Boolean(metadataTarget && canManage(metadataTarget))

  return (
    <section
      aria-label="Structure 관리 페이지"
      className="flex h-full min-h-0 flex-col overflow-auto lg:overflow-hidden"
    >
      <div
        className="grid min-h-0 flex-1 grid-cols-1 lg:h-full lg:grid-cols-[minmax(360px,var(--workspace-left-width))_5px_minmax(0,1fr)] lg:overflow-hidden"
        ref={workspaceRef}
        style={{ '--workspace-left-width': `${workspaceLeftPercent}%` } as CSSProperties}
      >
        <div className="min-h-[420px] min-w-0 border-b lg:h-full lg:min-h-0 lg:overflow-hidden lg:border-b-0">
          {editorOpen && structure ? (
            <div className="flex h-full min-h-0 flex-col bg-background">
              <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
                <Button size="sm" variant="ghost" onClick={() => updateEditorOpen(false)}>
                  <ArrowLeft />
                  목록
                </Button>
                {measurementReturnTo ? (
                  <Button size="sm" variant="outline" onClick={requestReturnToMeasurement}>
                    <ArrowLeft />
                    Measurement로 돌아가기
                  </Button>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1">
                    <p className="min-w-0 truncate text-sm font-semibold">
                      {selectedStructure?.name ?? '새 Structure'}
                    </p>
                    {selectedStructure ? (
                      <Button
                        aria-label={`${selectedStructure.name} ${selectedManageable ? '정보 편집' : '정보 보기'}`}
                        className="size-6"
                        size="icon"
                        title={selectedManageable ? '이름과 설명 편집' : '이름과 설명 보기'}
                        variant="ghost"
                        onClick={() => openMetadata(selectedStructure)}
                      >
                        {selectedManageable ? <Pencil /> : <Eye />}
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {selectedStructureId === null
                      ? '저장 전 새 Structure입니다.'
                      : dirty
                        ? '저장되지 않은 코드 변경이 있습니다.'
                        : '저장된 코드와 일치합니다.'}
                  </p>
                </div>
                {selectedStructureId === null && auth.isAuthenticated ? (
                  <Button size="sm" onClick={() => setSaveMode('create')}>
                    <Plus />
                    Structure 생성
                  </Button>
                ) : selectedManageable ? (
                  <Button size="sm" variant="outline" onClick={() => setSaveMode('save')}>
                    Structure 저장
                  </Button>
                ) : null}
                {selectedStructureId !== null && auth.isAuthenticated ? (
                  <Button size="sm" onClick={() => setSaveMode('root')}>
                    <Plus />새 root로 저장
                  </Button>
                ) : null}
              </div>
              <div className="min-h-0 flex-1">
                <StructureExperimentViewer
                  activeDocumentType="structure"
                  experiment={null}
                  experimentDocument={experimentDocument}
                  structure={structure}
                  structureDocument={structureDocument}
                  structureLineage={
                    selectedStructure ? (
                      <StructureLineage
                        canManage={canManage}
                        rows={rows}
                        selected={selectedStructure}
                        onDelete={setDeleteTarget}
                        onNavigate={(row) => requestNavigation(row, false)}
                      />
                    ) : null
                  }
                  structureVarsPanel={
                    <VarsControls
                      disabled={
                        structureDocument.status === 'Dirty' ||
                        structureDocument.status === 'Checking' ||
                        structureDocument.status === 'Compiling'
                      }
                      overridden={structureVars !== undefined}
                      schema={structureDocument.varsSchema}
                      variables={structureVars ?? structureDocument.variables}
                      onChange={setStructureVars}
                      onReset={() => setStructureVars(undefined)}
                    />
                  }
                  onActiveDocumentTypeChange={() => undefined}
                />
              </div>
            </div>
          ) : (
            <Card className="flex h-full min-h-0 flex-col overflow-hidden rounded-none border-0 shadow-none">
              <div className="border-b bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold">Structure</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {leafRows.length.toLocaleString()} leaf / {rows.length.toLocaleString()} visible
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {measurementReturnTo ? (
                      <Button size="sm" onClick={requestReturnToMeasurement}>
                        <ArrowLeft />
                        Measurement로 돌아가기
                      </Button>
                    ) : null}
                    {auth.isAuthenticated ? (
                      <Button size="sm" variant="outline" onClick={requestNewStructure}>
                        <Plus />새 Structure 생성
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="relative mt-4">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label="Structure 검색"
                    className="pl-9"
                    placeholder="이름 또는 설명 검색"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {structuresQuery.isLoading ? (
                  <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle className="animate-spin" />
                    Structure 목록을 불러오는 중입니다.
                  </div>
                ) : structuresQuery.isError ? (
                  <div className="flex min-h-48 items-center justify-center text-sm text-destructive">
                    Structure 목록을 불러오지 못했습니다.
                  </div>
                ) : (
                  <DataTable
                    columns={columns}
                    data={leafRows}
                    emptyLabel="조건에 맞는 leaf Structure가 없습니다."
                    getRowKey={(row) => String(row.id)}
                    selectedKey={selectedStructureId === null ? undefined : String(selectedStructureId)}
                    onRowClick={(row) => requestNavigation(row, true)}
                    onRowDoubleClick={requestEditorOpen}
                  />
                )}
              </div>
            </Card>
          )}
        </div>
        <div
          aria-label="Structure 패널과 Viewer 크기 조절"
          aria-orientation="vertical"
          aria-valuemax={75}
          aria-valuemin={25}
          aria-valuenow={Math.round(workspaceLeftPercent)}
          className="group hidden cursor-col-resize touch-none items-stretch justify-center bg-muted outline-none hover:bg-neutral-200 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset lg:flex"
          role="separator"
          tabIndex={0}
          onDoubleClick={() => setWorkspaceLeftPercent(defaultWorkspaceLeftPercent)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            const width = workspaceRef.current?.getBoundingClientRect().width
            if (!width) return
            event.preventDefault()
            setWorkspaceLeftPercent((current) =>
              clampWorkspaceLeftPercent(current + (event.key === 'ArrowLeft' ? -2 : 2), width),
            )
          }}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            const bounds = workspaceRef.current?.getBoundingClientRect()
            if (bounds) {
              setWorkspaceLeftPercent(
                clampWorkspaceLeftPercent(((event.clientX - bounds.left) / bounds.width) * 100, bounds.width),
              )
            }
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          <span className="w-px bg-border group-hover:bg-neutral-400" />
        </div>
        <CadViewer
          experiment={experimentViewerDocument}
          recordedData={simulation.recordedData}
          simulation={{
            canRun: simulation.canRun,
            cancel: simulation.cancel,
            process: simulation.process,
            program: experimentDocument.simulationProgram,
            run: simulation.run,
            stale: simulation.stale,
          }}
          structure={structureViewerDocument}
          onRenderEnd={handleRenderEnd}
          onRenderError={handleRenderError}
          onRenderStart={handleRenderStart}
        />
      </div>

      <Dialog
        onOpenChange={(open) => !open && !metadataMutation.isPending && setMetadataTarget(null)}
        open={metadataTarget !== null}
      >
        <DialogContent>
          <form
            className="grid gap-5"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              if (metadataTarget && metadataEditable) {
                metadataMutation.mutate({
                  row: metadataTarget,
                  name: metadataName,
                  description: metadataDescription,
                })
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{metadataEditable ? 'Structure 정보 편집' : 'Structure 정보'}</DialogTitle>
              <DialogDescription>
                {metadataEditable
                  ? '코드는 변경하지 않고 이름과 설명만 저장합니다.'
                  : '이 Structure는 읽기 전용입니다.'}
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm font-medium">
              이름
              <Input
                autoFocus={metadataEditable}
                disabled={!metadataEditable}
                maxLength={200}
                value={metadataName}
                onChange={(event) => setMetadataName(event.target.value)}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              설명
              <textarea
                className="min-h-28 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                disabled={!metadataEditable}
                maxLength={2000}
                value={metadataDescription}
                onChange={(event) => setMetadataDescription(event.target.value)}
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMetadataTarget(null)}>
                닫기
              </Button>
              {metadataEditable ? (
                <Button disabled={!metadataName.trim() || metadataMutation.isPending} type="submit">
                  {metadataMutation.isPending ? <LoaderCircle className="animate-spin" /> : null}
                  저장
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <SaveDefinitionDialog
        defaults={saveDefaults}
        description={
          saveMode === 'create'
            ? '기본 Source code를 내 새 root Structure로 저장합니다.'
            : saveMode === 'root'
              ? '현재 Source code를 선택한 Structure의 parent 없이 내 새 root로 저장합니다.'
              : undefined
        }
        kind="Structure"
        open={saveMode !== null}
        pending={definitionMutation.isPending}
        submitLabel={
          saveMode === 'create' ? 'Structure 생성' : saveMode === 'root' ? '새 root로 저장' : 'Structure 저장'
        }
        title={
          saveMode === 'create'
            ? '새 Structure 생성'
            : saveMode === 'root'
              ? '새 Structure root 저장'
              : 'Structure 저장'
        }
        onOpenChange={(open) => !open && !definitionMutation.isPending && setSaveMode(null)}
        onSubmit={async (values) => {
          await definitionMutation.mutateAsync({ forceRoot: saveMode !== 'save', values })
        }}
      />

      <Dialog
        onOpenChange={(open) => {
          if (open) return
          setPendingNavigation(null)
          setPendingEditorOpen(false)
          setPendingCreate(false)
          setPendingReturn(false)
        }}
        open={pendingNavigation !== null || pendingCreate || pendingReturn}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>저장되지 않은 변경을 버릴까요?</DialogTitle>
            <DialogDescription>
              {pendingReturn
                ? 'Measurement로 돌아가면 현재 Editor의 코드 변경을 복구할 수 없습니다.'
                : pendingCreate
                  ? '새 Structure를 시작하면 현재 Editor의 코드 변경을 복구할 수 없습니다.'
                  : '다른 Structure로 이동하면 현재 Editor의 코드 변경을 복구할 수 없습니다.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingNavigation(null)
                setPendingEditorOpen(false)
                setPendingCreate(false)
                setPendingReturn(false)
              }}
            >
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingReturn) returnToMeasurement()
                else if (pendingCreate) startNewStructure()
                else if (pendingNavigation) {
                  applyStructure(pendingNavigation)
                  if (pendingEditorOpen) updateEditorOpen(true)
                }
                setPendingNavigation(null)
                setPendingEditorOpen(false)
                setPendingCreate(false)
                setPendingReturn(false)
              }}
            >
              변경 버리고 이동
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => !open && !deleteMutation.isPending && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Structure를 삭제할까요?</DialogTitle>
            <DialogDescription>
              child는 삭제 노드의 parent로 자동 재연결됩니다. 연결된 Sample과 Designer/Predictor Model도 함께 삭제될 수
              있습니다.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border bg-muted/20 p-3 text-sm">
            <span className="font-medium">{deleteTarget?.name}</span>
            <span className="ml-2 text-muted-foreground">Structure #{deleteTarget?.id}</span>
          </div>
          <DialogFooter>
            <Button disabled={deleteMutation.isPending} variant="outline" onClick={() => setDeleteTarget(null)}>
              취소
            </Button>
            <Button
              disabled={deleteMutation.isPending}
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
            >
              {deleteMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

export const Component = StructurePage
