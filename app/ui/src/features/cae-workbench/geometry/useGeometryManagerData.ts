import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { dbTables, geometryApi, getListRequest } from '@/api'
import { catalogApi, catalogQueryKeys } from '@/api/catalog'
import type { GeometryDraftVersion } from '../types'
import { GEOMETRY_MANAGER_ALL, GEOMETRY_MANAGER_EXAMPLES, type GeometryManagerFilters } from './geometryManagerTypes'
import { geometryCoordinateNamespace, geometryCoordinateRepository } from './geometryWorkspaceModel'
import type { GeometryManagerState } from './useGeometryWorkspaceState'

export function useGeometryManagerData({
  authenticated,
  draftVersions,
  experimentPage,
  experimentSearch,
  filters,
  geometry,
  isAdmin,
  selectedPackageId,
  selectedVersionId,
}: {
  authenticated: boolean
  draftVersions: readonly GeometryDraftVersion[]
  experimentPage: number
  experimentSearch: string
  filters: GeometryManagerFilters
  geometry: GeometryManagerState
  isAdmin: boolean
  selectedPackageId: number | null
  selectedVersionId: number | null
}) {
  const listScope: 'visible' | 'mine' = isAdmin ? 'visible' : 'mine'
  const selectedNamespace = filters.namespace
  const selectedRepositoryFilter = filters.repository
  const examplesVisible = selectedNamespace === GEOMETRY_MANAGER_EXAMPLES || selectedNamespace === GEOMETRY_MANAGER_ALL
  const workspaceVisible = selectedNamespace !== GEOMETRY_MANAGER_EXAMPLES
  const selectedExampleRepository = selectedRepositoryFilter.startsWith(`${GEOMETRY_MANAGER_EXAMPLES}/`)
    ? selectedRepositoryFilter.slice(GEOMETRY_MANAGER_EXAMPLES.length + 1)
    : undefined
  const examplesListVisible =
    examplesVisible && (selectedRepositoryFilter === GEOMETRY_MANAGER_ALL || Boolean(selectedExampleRepository))
  const workspaceListVisible = workspaceVisible && !selectedRepositoryFilter.startsWith(`${GEOMETRY_MANAGER_EXAMPLES}/`)

  const exampleRepositoriesQuery = useQuery({
    queryKey: catalogQueryKeys.geometryRepositories,
    queryFn: () => catalogApi.listGeometryRepositories(),
  })
  const officialListQuery = useQuery({
    enabled: examplesListVisible,
    queryKey: catalogQueryKeys.geometries({
      q: filters.search.trim(),
      repository: selectedExampleRepository,
      limit: 200,
    }),
    queryFn: () =>
      catalogApi.listGeometries({ q: filters.search.trim(), repository: selectedExampleRepository, limit: 200 }),
  })
  const officialDetailQuery = useQuery({
    enabled: geometry.managerView === 'examples' && geometry.selectedCatalogKey !== null,
    queryKey: catalogQueryKeys.geometry(geometry.selectedCatalogKey ?? ''),
    queryFn: () => catalogApi.getGeometry(geometry.selectedCatalogKey!),
  })
  const repositoriesQuery = useQuery({
    enabled: authenticated,
    queryKey: ['geometry', 'manager', 'repositories', listScope],
    queryFn: () =>
      dbTables.GeometryRepository.listRows({
        ...getListRequest(listScope),
        limit: null,
        sort: [
          ['namespace', 'asc'],
          ['slug', 'asc'],
        ],
      }),
  })

  const namespaces = useMemo(() => {
    const values = new Set((repositoriesQuery.data?.items ?? []).map((item) => item.namespace))
    for (const draft of draftVersions) {
      const namespace = geometryCoordinateNamespace(draft.coordinate)
      if (namespace) values.add(namespace)
    }
    if (geometry.namespace) values.add(geometry.namespace)
    if (!authenticated) values.add('local')
    if (selectedNamespace !== GEOMETRY_MANAGER_ALL && selectedNamespace !== GEOMETRY_MANAGER_EXAMPLES) {
      values.add(selectedNamespace)
    }
    return [...values].sort()
  }, [authenticated, draftVersions, geometry.namespace, repositoriesQuery.data?.items, selectedNamespace])
  const owners = useMemo(
    () =>
      [
        ...new Set(
          (repositoriesQuery.data?.items ?? [])
            .map((item) => item.user_id)
            .filter((item): item is string => Boolean(item)),
        ),
      ].sort(),
    [repositoriesQuery.data?.items],
  )
  const repositoryOptions = useMemo(() => {
    const options: { key: string; label: string; example: boolean }[] = []
    if (examplesVisible) {
      for (const repository of exampleRepositoriesQuery.data ?? []) {
        options.push({
          key: `${GEOMETRY_MANAGER_EXAMPLES}/${repository.slug}`,
          label: selectedNamespace === GEOMETRY_MANAGER_ALL ? `Examples/${repository.title}` : repository.title,
          example: true,
        })
      }
    }
    if (workspaceVisible) {
      for (const repository of repositoriesQuery.data?.items ?? []) {
        if (selectedNamespace !== GEOMETRY_MANAGER_ALL && repository.namespace !== selectedNamespace) continue
        options.push({
          key: `${repository.namespace}/${repository.slug}`,
          label:
            selectedNamespace === GEOMETRY_MANAGER_ALL ? `${repository.namespace}/${repository.slug}` : repository.slug,
          example: false,
        })
      }
      for (const draft of draftVersions) {
        const key = geometryCoordinateRepository(draft.coordinate)
        const namespace = geometryCoordinateNamespace(draft.coordinate)
        if (!key || !namespace || (selectedNamespace !== GEOMETRY_MANAGER_ALL && namespace !== selectedNamespace)) {
          continue
        }
        if (!options.some((item) => item.key === key)) {
          options.push({
            key,
            label: selectedNamespace === GEOMETRY_MANAGER_ALL ? key : draft.repository,
            example: false,
          })
        }
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label))
  }, [
    draftVersions,
    exampleRepositoriesQuery.data,
    examplesVisible,
    repositoriesQuery.data?.items,
    selectedNamespace,
    workspaceVisible,
  ])

  const selectedDbRepository = (repositoriesQuery.data?.items ?? []).find(
    (item) => `${item.namespace}/${item.slug}` === selectedRepositoryFilter,
  )
  const packageRequest = useMemo(
    () => ({
      ...getListRequest(listScope),
      offset: 0,
      limit: (filters.page + 1) * filters.pageSize,
      search_text: filters.search.trim() || null,
      text_filter: {
        ...(selectedNamespace !== GEOMETRY_MANAGER_ALL && selectedNamespace !== GEOMETRY_MANAGER_EXAMPLES
          ? { namespace: [selectedNamespace] }
          : {}),
        ...(filters.owner ? { owner_id: [filters.owner] } : {}),
      },
      filter: selectedDbRepository
        ? { repository_id: [selectedDbRepository.id, selectedDbRepository.id] }
        : ({} as Record<string, unknown[]>),
      null_filter:
        filters.archive === 'all'
          ? ({} as Record<string, 'is_null' | 'is_not_null'>)
          : {
              repository_archived_at: filters.archive === 'active' ? ('is_null' as const) : ('is_not_null' as const),
            },
      sort: [
        ['updated_at', 'desc'],
        ['name', 'asc'],
      ] as [string, 'asc' | 'desc'][],
    }),
    [filters, listScope, selectedDbRepository, selectedNamespace],
  )
  const packagesQuery = useQuery({
    enabled: authenticated && workspaceListVisible,
    queryKey: ['geometry', 'manager', 'packages', packageRequest],
    queryFn: () => dbTables.GeometryPackage.listRows(packageRequest),
  })

  const selectedManagerVersionId =
    geometry.managerModules.find((module) => module.coordinate === geometry.selectedCoordinate)?.geometryVersionId ??
    null
  const initialVersionQuery = useQuery({
    enabled: authenticated && selectedManagerVersionId !== null,
    queryKey: ['geometry', 'manager', 'initial-version', selectedManagerVersionId, listScope],
    queryFn: () =>
      dbTables.GeometryVersion.listRows({
        ...getListRequest(listScope, selectedManagerVersionId ? [selectedManagerVersionId] : []),
        limit: 1,
      }),
  })
  const selectedPackageQuery = useQuery({
    enabled: authenticated && selectedPackageId !== null,
    queryKey: ['geometry', 'manager', 'package', selectedPackageId, listScope],
    queryFn: async () => {
      const result = await dbTables.GeometryPackage.listRows({
        ...getListRequest(listScope, selectedPackageId ? [selectedPackageId] : []),
        limit: 1,
      })
      return result.items[0] ?? null
    },
  })
  const versionsQuery = useQuery({
    enabled: authenticated && selectedPackageId !== null,
    queryKey: ['geometry', 'manager', 'versions', selectedPackageId, listScope],
    queryFn: () =>
      dbTables.GeometryVersion.listRows({
        ...getListRequest(listScope),
        limit: null,
        filter: selectedPackageId ? { package_id: [selectedPackageId, selectedPackageId] } : {},
        sort: [
          ['version_major', 'desc'],
          ['version_minor', 'desc'],
          ['version_patch', 'desc'],
        ],
      }),
  })
  const versions = useMemo(() => versionsQuery.data?.items ?? [], [versionsQuery.data?.items])
  const selectedVersion = versions.find((item) => item.id === selectedVersionId) ?? null
  const resolvedQuery = useQuery({
    enabled: authenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'resolve', selectedVersionId],
    queryFn: () => geometryApi.resolveVersion(selectedVersionId!),
  })
  const usageQuery = useQuery({
    enabled: authenticated && versions.length > 0,
    queryKey: ['geometry', 'manager', 'usage', versions.map((item) => item.id)],
    queryFn: () => geometryApi.versionUsage(versions.map((item) => item.id)),
  })
  const dependentRequest = useMemo(
    () => ({ ...getListRequest(listScope), limit: 12, sort: ['updated_at', 'desc'] as [string, 'desc'] }),
    [listScope],
  )
  const dependentsQuery = useQuery({
    enabled: authenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'dependents', selectedVersionId, dependentRequest],
    queryFn: () => geometryApi.listDependents(selectedVersionId!, dependentRequest),
  })
  const experimentRequest = useMemo(
    () => ({
      ...getListRequest(listScope),
      offset: experimentPage * 10,
      limit: 10,
      search_text: experimentSearch.trim() || null,
      sort: ['updated_at', 'desc'] as [string, 'desc'],
    }),
    [experimentPage, experimentSearch, listScope],
  )
  const experimentsQuery = useQuery({
    enabled: authenticated && selectedVersionId !== null,
    queryKey: ['geometry', 'manager', 'experiments', selectedVersionId, experimentRequest],
    queryFn: () => geometryApi.listReferencingExperiments(selectedVersionId!, experimentRequest),
  })

  return {
    dependentsQuery,
    examplesListVisible,
    examplesVisible,
    experimentsQuery,
    initialVersionQuery,
    listScope,
    namespaces,
    officialDetailQuery,
    officialListQuery,
    owners,
    packagesQuery,
    repositoriesQuery,
    repositoryOptions,
    resolvedQuery,
    selectedPackage: selectedPackageQuery.data ?? null,
    selectedVersion,
    usageQuery,
    versions,
    workspaceListVisible,
    workspaceVisible,
  }
}
