import { createStore, del, get, set } from 'idb-keyval'
import {
  MAX_GEOMETRY_MODULE_SOURCE_BYTES,
  MAX_GEOMETRY_MODULES,
  assertCadSourceDocument,
  assertExperimentSourceBundle,
  assertGeometryCoordinate,
  createGeometrySnapshot,
  validateGeometrySnapshotHashes,
  type GeometrySnapshotModule,
} from '@/lib/cad'
import { retainReferencedStagedModules } from '../geometry/useGeometryWorkspaceState'
import type { GeometryLocalDraft, WorkbenchDraft } from '../types'

export const WORKBENCH_DRAFT_VERSION = 4 as const
export const ANONYMOUS_WORKBENCH_USER = 'anonymous'

const draftsStore = createStore('caemble', 'cae-workbench-drafts')
const slugPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u
const aliasPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype,
  )
}

function validOptionalId(value: unknown) {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function validUtf8Text(value: unknown, maxBytes: number) {
  if (typeof value !== 'string') return false
  const encoded = new TextEncoder().encode(value)
  return encoded.byteLength <= maxBytes && new TextDecoder('utf-8', { fatal: true }).decode(encoded) === value
}

function validGeometryDrafts(value: unknown): value is WorkbenchDraft['geometry']['drafts'] {
  if (!plainObject(value) || Object.keys(value).length > MAX_GEOMETRY_MODULES) return false
  const draftIds = new Set<string>()
  const aliases = new Set<string>()
  try {
    return Object.entries(value).every(([coordinate, item]) => {
      assertGeometryCoordinate(coordinate)
      if (!plainObject(item) || item.coordinate !== coordinate) return false
      const draft = item as Partial<GeometryLocalDraft>
      if (
        typeof draft.draftId !== 'string' ||
        !draft.draftId ||
        draft.draftId.length > 128 ||
        draftIds.has(draft.draftId) ||
        !validUtf8Text(draft.source, MAX_GEOMETRY_MODULE_SOURCE_BYTES) ||
        typeof draft.description !== 'string' ||
        !validOptionalId(draft.baseGeometryVersionId) ||
        typeof draft.repository !== 'string' ||
        !slugPattern.test(draft.repository) ||
        typeof draft.packageName !== 'string' ||
        !slugPattern.test(draft.packageName) ||
        !validOptionalId(draft.repositoryId) ||
        !validOptionalId(draft.packageId) ||
        typeof draft.version !== 'string' ||
        !versionPattern.test(draft.version) ||
        draft.version.split('.').some((part) => Number(part) > 2_147_483_647) ||
        !['major', 'minor', 'patch'].includes(String(draft.bump)) ||
        typeof draft.standalonePreview !== 'boolean' ||
        (draft.rootAlias !== null &&
          (typeof draft.rootAlias !== 'string' || !aliasPattern.test(draft.rootAlias) || aliases.has(draft.rootAlias)))
      ) {
        return false
      }
      const parsed = /^caemble:geometry\/[^/]+\/([^/]+)\/([^@]+)@(\d+\.\d+\.\d+)$/u.exec(coordinate)
      if (!parsed || parsed[1] !== draft.repository || parsed[2] !== draft.packageName || parsed[3] !== draft.version) {
        return false
      }
      draftIds.add(draft.draftId)
      if (draft.rootAlias) aliases.add(draft.rootAlias)
      return true
    })
  } catch {
    return false
  }
}

function stagedSnapshot(modules: readonly GeometrySnapshotModule[]) {
  const imported = new Set(modules.flatMap((module) => module.imports.map((item) => item.coordinate)))
  const roots = modules
    .filter((module) => !imported.has(module.coordinate))
    .map((module, index) => ({
      alias: `staged_${index}`,
      geometryVersionId: module.geometryVersionId,
      coordinate: module.coordinate,
      moduleHash: module.moduleHash,
    }))
  return createGeometrySnapshot(roots, modules)
}

export function workbenchDraftUserKey(userId: string | null | undefined) {
  const normalized = userId?.trim()
  return normalized || ANONYMOUS_WORKBENCH_USER
}

function draftKey(userKey: string) {
  return `session:${encodeURIComponent(workbenchDraftUserKey(userKey))}`
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
      !validGeometryDrafts(draft.geometry.drafts) ||
      !Array.isArray(draft.geometry.stagedModules) ||
      draft.geometry.stagedModules.length > MAX_GEOMETRY_MODULES ||
      (draft.geometry.selectedCoordinate !== null && typeof draft.geometry.selectedCoordinate !== 'string') ||
      !Array.isArray(draft.geometry.expandedPaths) ||
      draft.geometry.expandedPaths.length > 1024 ||
      draft.geometry.expandedPaths.some((path) => typeof path !== 'string' || path.length > 4096) ||
      !plainObject(draft.layout) ||
      !Array.isArray(draft.layout.openTabs) ||
      draft.layout.openTabs.length > 3 ||
      draft.layout.openTabs.some((tab) => !['experiment', 'geometry', 'recorded-data'].includes(tab)) ||
      (draft.layout.activeTab !== null &&
        !['experiment', 'geometry', 'recorded-data'].includes(draft.layout.activeTab)) ||
      (draft.layout.experimentFile !== null &&
        (typeof draft.layout.experimentFile !== 'string' || draft.layout.experimentFile.length > 1024)) ||
      !Number.isFinite(draft.layout.splitPercent)
    ) {
      return false
    }
    if (draft.experiment.document !== null) assertCadSourceDocument(draft.experiment.document)
    if (draft.experiment.baselineBundle !== null) assertExperimentSourceBundle(draft.experiment.baselineBundle)
    if (draft.experiment.record !== null) {
      if (
        !plainObject(draft.experiment.record) ||
        !validOptionalId(draft.experiment.record.id) ||
        typeof draft.experiment.record.name !== 'string' ||
        (draft.experiment.record.description !== null && typeof draft.experiment.record.description !== 'string') ||
        !/^[0-9a-f]{64}$/u.test(String(draft.experiment.record.source_hash))
      ) {
        return false
      }
      assertExperimentSourceBundle(draft.experiment.record.source_bundle)
    }
    if (draft.geometry.selectedCoordinate !== null) assertGeometryCoordinate(draft.geometry.selectedCoordinate)
    const geometry = draft.geometry
    stagedSnapshot(geometry.stagedModules)
    const persistedModules = new Map(
      draft.experiment.document?.sourceBundle.formatVersion === 3
        ? draft.experiment.document.sourceBundle.geometrySnapshot.modules.map((module) => [module.coordinate, module])
        : [],
    )
    if (
      geometry.stagedModules.some((module) => {
        const persisted = persistedModules.get(module.coordinate)
        return persisted && persisted.moduleHash !== module.moduleHash
      })
    ) {
      return false
    }
    const persistedAliases = new Set(
      draft.experiment.document?.sourceBundle.formatVersion === 3
        ? draft.experiment.document.sourceBundle.geometrySnapshot.roots.map((root) => root.alias)
        : [],
    )
    if (Object.values(geometry.drafts).some((item) => item.rootAlias && persistedAliases.has(item.rootAlias))) {
      return false
    }
    if (
      retainReferencedStagedModules(geometry.drafts, geometry.stagedModules).length !== geometry.stagedModules.length
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function migrateWorkbenchDraft(value: unknown, userKey: string): WorkbenchDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Record<string, unknown>
  if (
    ![2, 3].includes(Number(draft.version)) ||
    draft.userKey !== userKey ||
    typeof draft.savedAt !== 'number' ||
    !draft.experiment ||
    !draft.candidate ||
    !draft.selection ||
    !draft.layout
  ) {
    return null
  }
  if (draft.version === 3 && plainObject(draft.geometry)) {
    const geometry = draft.geometry as unknown as WorkbenchDraft['geometry']
    return {
      ...(draft as unknown as Omit<WorkbenchDraft, 'version' | 'geometry'>),
      version: WORKBENCH_DRAFT_VERSION,
      geometry: {
        ...geometry,
        drafts: Object.fromEntries(
          Object.entries(geometry.drafts).map(([coordinate, item]) => [
            coordinate,
            { ...item, standalonePreview: false },
          ]),
        ),
      },
    }
  }
  return {
    ...(draft as unknown as Omit<WorkbenchDraft, 'version' | 'geometry'>),
    version: WORKBENCH_DRAFT_VERSION,
    geometry: { drafts: {}, stagedModules: [], selectedCoordinate: null, expandedPaths: [] },
  }
}

export async function loadWorkbenchDraft(userKey: string) {
  const normalizedUserKey = workbenchDraftUserKey(userKey)
  const key = draftKey(normalizedUserKey)
  const stored = await get<unknown>(key, draftsStore)
  if (stored === undefined) return null
  if (isWorkbenchDraft(stored, normalizedUserKey)) {
    try {
      await validateGeometrySnapshotHashes(stagedSnapshot(stored.geometry.stagedModules))
      return stored
    } catch {
      await del(key, draftsStore)
      return null
    }
  }
  const migrated = migrateWorkbenchDraft(stored, normalizedUserKey)
  if (migrated) {
    await set(key, migrated, draftsStore)
    return migrated
  }
  await del(key, draftsStore)
  return null
}

export function saveWorkbenchDraft(draft: WorkbenchDraft) {
  const userKey = workbenchDraftUserKey(draft.userKey)
  const storedDraft = userKey === draft.userKey ? draft : { ...draft, userKey }
  return set(draftKey(userKey), storedDraft, draftsStore)
}

export function clearWorkbenchDraft(userKey: string) {
  return del(draftKey(userKey), draftsStore)
}
