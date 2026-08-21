import { useCallback, useMemo, useState } from 'react'
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
  initialPackageId: number | null
  initialVersionId: number | null
}

export function useGeometryManagerController({
  geometry,
  initialPackageId,
  initialVersionId,
}: GeometryManagerControllerProps) {
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
  const [selectedPackageId, setSelectedPackageId] = useState<number | null>(initialPackageId)
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(initialVersionId)
  const [pendingVersionId, setPendingVersionId] = useState<number | null>(null)
  const [selectedDraftCoordinate, setSelectedDraftCoordinate] = useState<GeometryModuleCoordinate | null>(null)
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

  const selection = useMemo<GeometryManagerSelection>(() => {
    if (selectedDraftCoordinate) return { kind: 'draft', coordinate: selectedDraftCoordinate }
    if (selectedPackageId !== null)
      return { kind: 'package', packageId: selectedPackageId, versionId: selectedVersionId }
    if (geometry.managerView === 'examples' && geometry.selectedCatalogKey) {
      return { kind: 'example', key: geometry.selectedCatalogKey }
    }
    return { kind: 'none' }
  }, [geometry.managerView, geometry.selectedCatalogKey, selectedDraftCoordinate, selectedPackageId, selectedVersionId])

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
      setSelectedPackageId(null)
      setSelectedVersionId(null)
      setSelectedDraftCoordinate(null)
      setPendingVersionId(null)
      setSelectedCoordinate(null)
      setSelectedCatalogKey(key)
      setManagerView('examples')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectDraft = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      setSelectedPackageId(null)
      setSelectedVersionId(null)
      setSelectedDraftCoordinate(coordinate)
      setPendingVersionId(null)
      setSelectedCoordinate(coordinate)
      setSelectedCatalogKey(null)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectPackage = useCallback(
    (packageId: number) => {
      setSelectedDraftCoordinate(null)
      setPendingVersionId(null)
      setSelectedVersionId(null)
      setSelectedPackageId(packageId)
      setSelectedCoordinate(null)
      setSelectedCatalogKey(null)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCatalogKey, setSelectedCoordinate, setMobileDetailOpen],
  )

  const selectVersion = useCallback(
    (versionId: number, coordinate: GeometryModuleCoordinate) => {
      setSelectedDraftCoordinate(null)
      setSelectedVersionId(versionId)
      setSelectedCoordinate(coordinate)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCoordinate, setMobileDetailOpen],
  )

  const openDraft = useCallback(
    (coordinate: GeometryModuleCoordinate) => {
      setSelectedDraftCoordinate(coordinate)
      setSelectedCoordinate(coordinate)
      setManagerView('workspace')
      setMobileDetailOpen(true)
    },
    [setManagerView, setSelectedCoordinate, setMobileDetailOpen],
  )

  const clearSelection = useCallback(() => {
    setSelectedPackageId(null)
    setSelectedVersionId(null)
    setSelectedDraftCoordinate(null)
    setPendingVersionId(null)
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
    pendingVersionId,
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
