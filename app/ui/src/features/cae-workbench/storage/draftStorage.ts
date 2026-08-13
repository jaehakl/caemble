import { createStore, del, get, set } from 'idb-keyval'
import {
  MAX_GEOMETRY_MODULE_SOURCE_BYTES,
  MAX_GEOMETRY_MODULES,
  MAX_GEOMETRY_SEMVER_COMPONENT,
  analyzeGeometrySource,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  assertGeometryCoordinate,
  createExperimentSourceBundle,
  createGeometrySnapshot,
  validateGeometrySnapshotHashes,
  type GeometrySnapshotModule,
} from '@/lib/cad'
import type { GeometryLocalDraft, WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_VERSION = 7 as const
export const ANONYMOUS_WORKBENCH_USER = 'anonymous'

const draftsStore = createStore('caemble', 'cae-workbench-drafts')
const localCoordinatePattern =
  /^caemble:geometry\/[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?@local$/u
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u

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

function validDrafts(value: unknown): value is WorkbenchDraft['geometry']['drafts'] {
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

export function workbenchDraftUserKey(userId: string | null | undefined) {
  return userId?.trim() || ANONYMOUS_WORKBENCH_USER
}

function draftKey(userKey: string) {
  return `session:${encodeURIComponent(workbenchDraftUserKey(userKey))}`
}

function validSelectedCoordinate(value: unknown) {
  if (value === null || value === 'geometry.tsx') return true
  if (typeof value !== 'string') return false
  if (localCoordinatePattern.test(value)) return true
  try {
    assertGeometryCoordinate(value)
    return true
  } catch {
    return false
  }
}

function isWorkbenchDraft(value: unknown, userKey: string): value is WorkbenchDraft {
  if (!plainObject(value)) return false
  const draft = value as unknown as WorkbenchDraft
  try {
    if (
      draft.version !== WORKBENCH_DRAFT_VERSION ||
      draft.userKey !== userKey ||
      !Number.isFinite(draft.savedAt) ||
      !plainObject(draft.experiment) ||
      typeof draft.experiment.name !== 'string' ||
      typeof draft.experiment.description !== 'string' ||
      !plainObject(draft.candidate) ||
      (draft.candidate.vars !== null && !plainObject(draft.candidate.vars)) ||
      (draft.candidate.materialParameters !== null && !plainObject(draft.candidate.materialParameters)) ||
      !plainObject(draft.selection) ||
      !validOptionalId(draft.selection.measurementId) ||
      !plainObject(draft.geometry) ||
      !validDrafts(draft.geometry.drafts) ||
      !Array.isArray(draft.geometry.stagedModules) ||
      draft.geometry.stagedModules.length > MAX_GEOMETRY_MODULES ||
      !validSelectedCoordinate(draft.geometry.selectedCoordinate) ||
      (draft.geometry.selectedExport !== null && typeof draft.geometry.selectedExport !== 'string') ||
      !Array.isArray(draft.geometry.expandedPaths) ||
      draft.geometry.expandedPaths.some((path) => typeof path !== 'string' || path.length > 4096) ||
      !plainObject(draft.layout) ||
      !Array.isArray(draft.layout.openTabs) ||
      draft.layout.openTabs.some((tab) => !['experiment', 'geometry', 'recorded-data'].includes(tab)) ||
      (draft.layout.activeTab !== null &&
        !['experiment', 'geometry', 'recorded-data'].includes(draft.layout.activeTab)) ||
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
    stagedSnapshot(draft.geometry.stagedModules)
    return true
  } catch {
    return false
  }
}

function hasLegacyGeometry(value: Record<string, unknown>) {
  const experiment = plainObject(value.experiment) ? value.experiment : {}
  const document = plainObject(experiment.document) ? experiment.document : null
  const record = plainObject(experiment.record) ? experiment.record : null
  const bundles = [document?.sourceBundle, experiment.baselineBundle, record?.source_bundle]
  const geometry = plainObject(value.geometry) ? value.geometry : null
  return (
    bundles.some((candidate) => {
      if (!plainObject(candidate)) return false
      const files = plainObject(candidate.files) ? candidate.files : {}
      const geometrySource = typeof files['geometry.tsx'] === 'string' ? files['geometry.tsx'].trim() : ''
      const snapshot = plainObject(candidate.geometrySnapshot) ? candidate.geometrySnapshot : null
      return (
        (geometrySource !== '' && geometrySource !== 'export {}') ||
        Boolean(snapshot && Array.isArray(snapshot.modules) && snapshot.modules.length) ||
        Boolean(snapshot && Array.isArray(snapshot.roots) && snapshot.roots.length) ||
        Boolean(snapshot && Array.isArray(snapshot.entryImports) && snapshot.entryImports.length)
      )
    }) ||
    Boolean(geometry && plainObject(geometry.drafts) && Object.keys(geometry.drafts).length) ||
    Boolean(geometry && Array.isArray(geometry.stagedModules) && geometry.stagedModules.length)
  )
}

function migrateBundle(value: unknown) {
  if (!plainObject(value) || !plainObject(value.files)) return value
  const files = Object.fromEntries(
    Object.entries(value.files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return createExperimentSourceBundle(files, { schemaVersion: 2, entryImports: [], modules: [] })
}

function migrateWorkbenchDraft(value: unknown, userKey: string): WorkbenchDraft | null {
  if (!plainObject(value) || ![2, 3, 4, 5, 6].includes(Number(value.version)) || value.userKey !== userKey) return null
  if (hasLegacyGeometry(value)) return null
  const experiment = plainObject(value.experiment) ? value.experiment : null
  if (!experiment || !plainObject(value.candidate) || !plainObject(value.selection) || !plainObject(value.layout))
    return null
  const document = plainObject(experiment.document)
    ? { ...experiment.document, sourceBundle: migrateBundle(experiment.document.sourceBundle) }
    : null
  const record = plainObject(experiment.record)
    ? { ...experiment.record, source_bundle: migrateBundle(experiment.record.source_bundle) }
    : null
  return {
    ...(value as unknown as WorkbenchDraft),
    version: WORKBENCH_DRAFT_VERSION,
    experiment: {
      ...(experiment as WorkbenchDraft['experiment']),
      document: document as WorkbenchDraft['experiment']['document'],
      record: record as WorkbenchDraft['experiment']['record'],
      baselineBundle: migrateBundle(experiment.baselineBundle) as WorkbenchDraft['experiment']['baselineBundle'],
    },
    geometry: {
      drafts: {},
      stagedModules: [],
      selectedCoordinate: 'geometry.tsx',
      selectedExport: null,
      expandedPaths: ['geometry.tsx'],
    },
  }
}

export async function loadWorkbenchDraft(userKey: string) {
  const normalized = workbenchDraftUserKey(userKey)
  const key = draftKey(normalized)
  const stored = await get<unknown>(key, draftsStore)
  if (stored === undefined) return null
  if (isWorkbenchDraft(stored, normalized)) {
    try {
      await validateGeometrySnapshotHashes(stagedSnapshot(stored.geometry.stagedModules))
      return stored
    } catch {
      await del(key, draftsStore)
      return null
    }
  }
  const migrated = migrateWorkbenchDraft(stored, normalized)
  if (migrated && isWorkbenchDraft(migrated, normalized)) {
    await set(key, migrated, draftsStore)
    return migrated
  }
  await del(key, draftsStore)
  return null
}

export function saveWorkbenchDraft(draft: WorkbenchDraft) {
  const userKey = workbenchDraftUserKey(draft.userKey)
  return set(draftKey(userKey), userKey === draft.userKey ? draft : { ...draft, userKey }, draftsStore)
}

export function clearWorkbenchDraft(userKey: string) {
  return del(draftKey(userKey), draftsStore)
}
