import { useCallback, useMemo, useReducer, useState } from 'react'
import type { CatalogGeometryDetail } from '@/api/catalog'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import type { GeometryManagerState } from './useGeometryWorkspaceState'
import {
  GEOMETRY_MANAGER_ALL,
  type GeometryManagerFilters,
  type GeometryManagerSelection,
} from './geometryManagerTypes'

type GeometryManagerPageSize = 12 | 24 | 48

type GeometryManagerControllerProps = {
  geometry: GeometryManagerState
}

type SelectionState = Readonly<{
  current: GeometryManagerSelection
  pendingVersionId: number | null
}>

type SelectionAction =
  | Readonly<{ type: 'select'; selection: GeometryManagerSelection }>
  | Readonly<{ type: 'package'; packageId: number | null }>
  | Readonly<{ type: 'version'; versionId: number | null }>
  | Readonly<{ type: 'draft'; coordinate: GeometryModuleCoordinate | null; packageId: number | null }>
  | Readonly<{ type: 'pending-version'; versionId: number | null }>
  | Readonly<{ type: 'clear' }>

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'select':
      return { current: action.selection, pendingVersionId: null }
    case 'package':
      if (action.packageId === null) {
        return state.current.kind === 'package' || state.current.kind === 'draft'
          ? { current: { kind: 'none' }, pendingVersionId: null }
          : state
      }
      return {
        current: {
          kind: 'package',
          packageId: action.packageId,
          versionId:
            state.current.kind === 'package' && state.current.packageId === action.packageId
              ? state.current.versionId
              : null,
        },
        pendingVersionId: null,
      }
    case 'version':
      if (state.current.kind === 'package') {
        return { ...state, current: { ...state.current, versionId: action.versionId } }
      }
      return state.current.kind === 'draft' && state.current.packageId !== null
        ? {
            ...state,
            current: { kind: 'package', packageId: state.current.packageId, versionId: action.versionId },
          }
        : state
    case 'draft':
      if (action.coordinate) {
        return {
          current: { kind: 'draft', coordinate: action.coordinate, packageId: action.packageId },
          pendingVersionId: null,
        }
      }
      return state.current.kind === 'draft'
        ? {
            current:
              state.current.packageId === null
                ? { kind: 'none' }
                : { kind: 'package', packageId: state.current.packageId, versionId: null },
            pendingVersionId: null,
          }
        : state
    case 'pending-version':
      return { ...state, pendingVersionId: action.versionId }
    case 'clear':
      return { current: { kind: 'none' }, pendingVersionId: null }
  }
}

export function useGeometryManagerController({ geometry }: GeometryManagerControllerProps) {
  const setManagerNamespace = geometry.setManagerNamespace
  const setManagerRepository = geometry.setManagerRepository
  const setSelectedCoordinate = geometry.setSelectedCoordinate
  const setSelectedCatalogKey = geometry.setSelectedCatalogKey
  const setManagerView = geometry.setManagerView
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<GeometryManagerPageSize>(24)
  const [owner, setOwner] = useState('')
  const [archive, setArchive] = useState<GeometryManagerFilters['archive']>('active')
  const [selectionState, dispatchSelection] = useReducer(selectionReducer, {
    current:
      geometry.managerView === 'examples' && geometry.selectedCatalogKey
        ? { kind: 'example', key: geometry.selectedCatalogKey }
        : { kind: 'none' },
    pendingVersionId: null,
  })
  const [checkedPackageIds, setCheckedPackageIds] = useState<Set<number>>(new Set())
  const [experimentSearch, setExperimentSearch] = useState('')
  const [experimentPage, setExperimentPage] = useState(0)
  const [usageExample, setUsageExample] = useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createRepositoryId, setCreateRepositoryId] = useState<number | null>(null)
  const [forkDetail, setForkDetail] = useState<CatalogGeometryDetail | null>(null)
  const [forkRepositoryId, setForkRepositoryId] = useState<number | null>(null)
  const [repositoryManagerOpen, setRepositoryManagerOpen] = useState(false)
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)

  const filters = useMemo<GeometryManagerFilters>(
    () => ({
      search,
      namespace: geometry.managerNamespace,
      repository: geometry.managerRepository,
      owner,
      archive,
      page,
      pageSize,
    }),
    [archive, geometry.managerNamespace, geometry.managerRepository, owner, page, pageSize, search],
  )

  const selection = selectionState.current
  const selectedPackageId = selection.kind === 'package' || selection.kind === 'draft' ? selection.packageId : null
  const selectedVersionId = selection.kind === 'package' ? selection.versionId : null
  const selectedDraftCoordinate = selection.kind === 'draft' ? selection.coordinate : null
  const setSelectedPackageId = useCallback(
    (packageId: number | null) => dispatchSelection({ type: 'package', packageId }),
    [],
  )
  const setSelectedVersionId = useCallback(
    (versionId: number | null) => dispatchSelection({ type: 'version', versionId }),
    [],
  )
  const setSelectedDraftCoordinate = useCallback(
    (coordinate: GeometryModuleCoordinate | null) =>
      dispatchSelection({
        type: 'draft',
        coordinate,
        packageId: coordinate ? (geometry.draftVersions[coordinate]?.packageId ?? selectedPackageId) : null,
      }),
    [geometry.draftVersions, selectedPackageId],
  )
  const setPendingVersionId = useCallback(
    (versionId: number | null) => dispatchSelection({ type: 'pending-version', versionId }),
    [],
  )

  const changeNamespace = useCallback(
    (namespace: string) => {
      setManagerNamespace(namespace)
      setManagerRepository(GEOMETRY_MANAGER_ALL)
      setPage(0)
    },
    [setManagerNamespace, setManagerRepository],
  )

  const changeRepository = useCallback(
    (repository: string) => {
      setManagerRepository(repository)
      setPage(0)
    },
    [setManagerRepository],
  )

  const resetFilters = useCallback(() => {
    setManagerNamespace(GEOMETRY_MANAGER_ALL)
    setManagerRepository(GEOMETRY_MANAGER_ALL)
    setSearch('')
    setOwner('')
    setArchive('active')
    setPage(0)
  }, [setManagerNamespace, setManagerRepository])

  const selectExample = useCallback(
    (key: string) => {
      dispatchSelection({ type: 'select', selection: { kind: 'example', key } })
      setSelectedCoordinate(null)
      setSelectedCatalogKey(key)
      setManagerView('examples')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectDraft = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      dispatchSelection({ type: 'select', selection: { kind: 'draft', coordinate, packageId: null } })
      setSelectedCoordinate(coordinate)
      setSelectedCatalogKey(null)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectPackage = useCallback(
    (packageId: number) => {
      dispatchSelection({ type: 'select', selection: { kind: 'package', packageId, versionId: null } })
      setSelectedCoordinate(null)
      setSelectedCatalogKey(null)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectVersion = useCallback(
    (versionId: number, coordinate: GeometryModuleCoordinate) => {
      dispatchSelection({ type: 'version', versionId })
      setSelectedCoordinate(coordinate)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCoordinate, setMobileDetailOpen],
  )

  const openDraft = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      dispatchSelection({
        type: 'select',
        selection: {
          kind: 'draft',
          coordinate,
          packageId: geometry.draftVersions[coordinate]?.packageId ?? selectedPackageId,
        },
      })
      setSelectedCoordinate(coordinate)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [geometry.draftVersions, selectedPackageId, setManagerView, setSelectedCoordinate, setMobileDetailOpen],
  )

  const clearSelection = useCallback(() => {
    dispatchSelection({ type: 'clear' })
    setSelectedCoordinate(null)
    setSelectedCatalogKey(null)
    setMobileDetailOpen(false)
  }, [setMobileDetailOpen, setSelectedCatalogKey, setSelectedCoordinate])

  return {
    filters,
    selection,
    search,
    setSearch,
    page,
    setPage,
    pageSize,
    setPageSize,
    ownerFilter: owner,
    setOwnerFilter: setOwner,
    archiveFilter: archive,
    setArchiveFilter: setArchive,
    selectedPackageId,
    setSelectedPackageId,
    selectedVersionId,
    setSelectedVersionId,
    pendingVersionId: selectionState.pendingVersionId,
    setPendingVersionId,
    selectedDraftCoordinate,
    setSelectedDraftCoordinate,
    checkedPackageIds,
    setCheckedPackageIds,
    experimentSearch,
    setExperimentSearch,
    experimentPage,
    setExperimentPage,
    usageExample,
    setUsageExample,
    createDialogOpen,
    setCreateDialogOpen,
    createRepositoryId,
    setCreateRepositoryId,
    forkDetail,
    setForkDetail,
    forkRepositoryId,
    setForkRepositoryId,
    repositoryManagerOpen,
    setRepositoryManagerOpen,
    workspaceSettingsOpen,
    setWorkspaceSettingsOpen,
    mobileDetailOpen,
    setMobileDetailOpen,
    changeNamespace,
    changeRepository,
    resetFilters,
    selectExample,
    selectDraft,
    selectPackage,
    selectVersion,
    openDraft,
    clearSelection,
  }
}
