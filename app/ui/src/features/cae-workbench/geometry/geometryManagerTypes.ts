import type { CatalogGeometryListItem } from '@/api/catalog'
import type { GeometryPackageRecord } from '@/api'
import type { GeometryModuleCoordinate } from '@/lib/cad'
import type { GeometryDraftVersion } from '../types'

export const GEOMETRY_MANAGER_ALL = 'all' as const
export const GEOMETRY_MANAGER_EXAMPLES = 'examples' as const

export type GeometryManagerFilters = Readonly<{
  search: string
  namespace: string
  repository: string
  owner: string
  archive: 'active' | 'archived' | 'all'
  page: number
  pageSize: 12 | 24 | 48
}>

export type GeometryManagerSelection =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'example'; key: string }>
  | Readonly<{ kind: 'draft'; coordinate: GeometryModuleCoordinate; packageId: number | null }>
  | Readonly<{ kind: 'package'; packageId: number; versionId: number | null }>

export type GeometryManagerListRow =
  | Readonly<{ kind: 'example'; item: CatalogGeometryListItem; sortKey: string }>
  | Readonly<{ kind: 'draft'; item: GeometryDraftVersion; sortKey: string }>
  | Readonly<{ kind: 'package'; item: GeometryPackageRecord; sortKey: string }>

export type GeometryManagerRibbonAction = Readonly<{
  label: string
  disabled?: boolean
  disabledReason?: string
  onSelect: () => void
  destructive?: boolean
}>

export type GeometryManagerRibbonState = Readonly<{
  filters: GeometryManagerFilters
  authenticated: boolean
  isAdmin: boolean
  namespaces: readonly string[]
  owners: readonly string[]
  repositoryOptions: readonly Readonly<{ key: string; label: string; example: boolean }>[]
  filterActions: Readonly<{
    search: (value: string) => void
    namespace: (value: string) => void
    repository: (value: string) => void
    owner: (value: string) => void
    archive: (value: GeometryManagerFilters['archive']) => void
    reset: () => void
  }>
  selection: GeometryManagerSelection
  selectionLabel: string
  actions: Readonly<{
    newGeometry: GeometryManagerRibbonAction
    refresh: GeometryManagerRibbonAction
    resetFilters: GeometryManagerRibbonAction
    repositoryManager: GeometryManagerRibbonAction
    workspaceSettings: GeometryManagerRibbonAction
    forkExample: GeometryManagerRibbonAction
    editVersion: GeometryManagerRibbonAction
    useInExperiment: GeometryManagerRibbonAction
    publishDraft: GeometryManagerRibbonAction
    discardDraft: GeometryManagerRibbonAction
    archiveVersion: GeometryManagerRibbonAction
    deleteVersion: GeometryManagerRibbonAction
    deletePackage: GeometryManagerRibbonAction
  }>
}>
