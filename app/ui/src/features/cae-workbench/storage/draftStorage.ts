import {
  MAX_GEOMETRY_MODULE_SOURCE_BYTES,
  MAX_GEOMETRY_MODULES,
  MAX_GEOMETRY_SEMVER_COMPONENT,
  analyzeGeometrySource,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  assertGeometryCoordinate,
  createGeometrySnapshot,
  validateGeometrySnapshotHashes,
  type GeometrySnapshotModule,
} from '@/lib/cad'
import type { GeometryLocalDraft, WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_VERSION = 11 as const
export const WORKBENCH_DRAFT_STORAGE_KEY = 'caemble:cae-workbench-draft'

const localCoordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@local$/u
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const validTabs = ['experiment', 'geometry', 'recorded-data', 'ai-helper']

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validOptionalId(value: unknown) {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function validText(value: unknown, maxBytes: number) {
  if (typeof value !== 'string') return false
  const bytes = new TextEncoder().encode(value)
  return bytes.byteLength <= maxBytes && new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value
}

function validDrafts(value: unknown): value is WorkbenchDraft['geometryManager']['drafts'] {
  if (!plainObject(value) || Object.keys(value).length > MAX_GEOMETRY_MODULES) return false
  const ids = new Set<string>()
  try {
    return Object.entries(value).every(([coordinate, item]) => {
      if (!localCoordinatePattern.test(coordinate) || !plainObject(item) || item.coordinate !== coordinate) return false
      const draft = item as Partial<GeometryLocalDraft>
      const version = typeof draft.version === 'string' ? versionPattern.exec(draft.version) : null
      if (
        typeof draft.draftId !== 'string' ||
        !draft.draftId ||
        ids.has(draft.draftId) ||
        !validText(draft.source, MAX_GEOMETRY_MODULE_SOURCE_BYTES) ||
        typeof draft.description !== 'string' ||
        !validOptionalId(draft.baseGeometryVersionId) ||
        typeof draft.repository !== 'string' ||
        !slugPattern.test(draft.repository) ||
        typeof draft.packageName !== 'string' ||
        !slugPattern.test(draft.packageName) ||
        !validOptionalId(draft.repositoryId) ||
        !validOptionalId(draft.packageId) ||
        !version ||
        version.slice(1).some((part) => Number(part) > MAX_GEOMETRY_SEMVER_COMPONENT) ||
        !['major', 'minor', 'patch'].includes(String(draft.bump)) ||
        typeof draft.standalonePreview !== 'boolean'
      ) {
        return false
      }
      analyzeGeometrySource(draft.source!, { allowLocal: true })
      ids.add(draft.draftId)
      return true
    })
  } catch {
    return false
  }
}

function stagedSnapshot(modules: readonly GeometrySnapshotModule[]) {
  const imported = new Set(modules.flatMap((module) => module.imports.map((item) => item.coordinate)))
  const entryImports = modules
    .filter((module) => !imported.has(module.coordinate))
    .map((module, index) => {
      const exportName = analyzeGeometrySource(module.source).exports[0]?.name
      if (!exportName) throw new Error(`Staged Geometry에 named export가 없습니다: ${module.coordinate}`)
      return {
        exportName,
        alias: `Staged${index}`,
        geometryVersionId: module.geometryVersionId,
        coordinate: module.coordinate,
        moduleHash: module.moduleHash,
      }
    })
  return createGeometrySnapshot(entryImports, modules)
}

function validSelectedCoordinate(value: unknown) {
  if (value === null) return true
  if (typeof value !== 'string') return false
  if (localCoordinatePattern.test(value)) return true
  try {
    assertGeometryCoordinate(value)
    return true
  } catch {
    return false
  }
}

function isWorkbenchDraft(value: unknown): value is WorkbenchDraft {
  if (!plainObject(value)) return false
  const draft = value as unknown as WorkbenchDraft
  try {
    if (
      draft.version !== WORKBENCH_DRAFT_VERSION ||
      !Number.isFinite(draft.savedAt) ||
      !plainObject(draft.experiment) ||
      typeof draft.experiment.name !== 'string' ||
      typeof draft.experiment.description !== 'string' ||
      !plainObject(draft.candidate) ||
      (draft.candidate.vars !== null && !plainObject(draft.candidate.vars)) ||
      (draft.candidate.materialParameters !== null && !plainObject(draft.candidate.materialParameters)) ||
      !plainObject(draft.selection) ||
      !validOptionalId(draft.selection.measurementId) ||
      !plainObject(draft.geometryManager) ||
      !validDrafts(draft.geometryManager.drafts) ||
      !Array.isArray(draft.geometryManager.resolvedModules) ||
      draft.geometryManager.resolvedModules.length > MAX_GEOMETRY_MODULES ||
      !validSelectedCoordinate(draft.geometryManager.selectedCoordinate) ||
      (draft.geometryManager.selectedExport !== null && typeof draft.geometryManager.selectedExport !== 'string') ||
      !plainObject(draft.experimentGeometry) ||
      !Array.isArray(draft.experimentGeometry.stagedModules) ||
      draft.experimentGeometry.stagedModules.length > MAX_GEOMETRY_MODULES ||
      !plainObject(draft.layout) ||
      !Array.isArray(draft.layout.openTabs) ||
      draft.layout.openTabs.some((tab) => !validTabs.includes(tab)) ||
      (draft.layout.activeTab !== null && !validTabs.includes(draft.layout.activeTab)) ||
      (draft.layout.experimentFile !== null && typeof draft.layout.experimentFile !== 'string') ||
      !Number.isFinite(draft.layout.splitPercent)
    ) {
      return false
    }
    if (draft.experiment.document !== null) assertCadSourceDocument(draft.experiment.document)
    if (draft.experiment.baselineBundle !== null) assertExperimentSourceBundle(draft.experiment.baselineBundle)
    if (draft.experiment.record !== null) {
      if (!plainObject(draft.experiment.record)) return false
      assertExperimentSourceBundle(draft.experiment.record.source_bundle)
    }
    stagedSnapshot(draft.geometryManager.resolvedModules)
    stagedSnapshot(draft.experimentGeometry.stagedModules)
    return true
  } catch {
    return false
  }
}

function migrateWorkbenchDraft(value: unknown): unknown {
  if (!plainObject(value) || value.version !== 10 || !plainObject(value.geometry)) return value
  const geometry = value.geometry
  const selectedCoordinate = geometry.selectedCoordinate === 'geometry.tsx' ? null : geometry.selectedCoordinate
  const stagedModules = Array.isArray(geometry.stagedModules) ? geometry.stagedModules : []
  const rest = { ...value }
  delete rest.geometry
  return {
    ...rest,
    version: WORKBENCH_DRAFT_VERSION,
    geometryManager: {
      drafts: geometry.drafts,
      resolvedModules: stagedModules,
      selectedCoordinate,
      selectedExport: geometry.selectedExport,
    },
    experimentGeometry: { stagedModules },
  }
}

export async function loadWorkbenchDraft() {
  const serialized = sessionStorage.getItem(WORKBENCH_DRAFT_STORAGE_KEY)
  if (serialized === null) return null
  try {
    const stored = migrateWorkbenchDraft(JSON.parse(serialized) as unknown)
    if (!isWorkbenchDraft(stored)) throw new Error('Invalid Workbench draft.')
    await Promise.all([
      validateGeometrySnapshotHashes(stagedSnapshot(stored.geometryManager.resolvedModules)),
      validateGeometrySnapshotHashes(stagedSnapshot(stored.experimentGeometry.stagedModules)),
    ])
    return stored
  } catch {
    sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
    return null
  }
}

export async function saveWorkbenchDraft(draft: WorkbenchDraft) {
  sessionStorage.setItem(WORKBENCH_DRAFT_STORAGE_KEY, JSON.stringify(draft))
}

export async function clearWorkbenchDraft() {
  sessionStorage.removeItem(WORKBENCH_DRAFT_STORAGE_KEY)
}
