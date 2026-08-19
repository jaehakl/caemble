import {
  CadCompilationError,
  CadDocumentEvaluationError,
  cadSourceHash,
  canonicalizeGeometrySnapshot,
  createCadSourceDocument,
  createExperimentSourceBundle,
  evaluateDocument,
  generateRandomVars,
  inspectDocument,
  varsSchemaFingerprint,
  type CadDiagnostic,
  type ExperimentSourceBundle,
  type ExperimentSourceDocument,
  type GeometryDraftOverlay,
  type Vars,
} from '@/lib/cad'
import { fetchCatalogRuntimeSlice } from '@/lib/catalog/references'

export type AgentWorkspaceValidation = Readonly<{
  status: 'valid' | 'invalid' | 'unavailable'
  sourceHash: string | null
  catalogFingerprint: string | null
  varsSchemaFingerprint: string | null
  sceneHash: string | null
  taskSceneHashes: Readonly<Record<string, string>>
  diagnostics: readonly CadDiagnostic[]
  error: Readonly<{
    kind: 'catalog' | 'policy' | 'type' | 'evaluation' | 'timeout' | 'cancelled' | 'structural'
    message: string
  }> | null
}>

export type AgentCandidateCache = Map<string, Readonly<Vars>>

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function agentGeometryContextVersion(
  document: ExperimentSourceDocument,
  geometryDrafts: GeometryDraftOverlay = {},
) {
  return sha256(
    JSON.stringify({
      geometrySnapshot: canonicalizeGeometrySnapshot(document.sourceBundle.geometrySnapshot),
      drafts: Object.fromEntries(
        Object.entries(geometryDrafts)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([coordinate, draft]) => [coordinate, draft?.source ?? null]),
      ),
    }),
  )
}

export async function validateAgentWorkspace(
  runId: string,
  stagedBundle: ExperimentSourceBundle,
  candidateCache: AgentCandidateCache,
  options: Readonly<{
    geometryDrafts?: GeometryDraftOverlay
    signal?: AbortSignal
    timeoutMs?: 3000 | 10000 | 30000
  }> = {},
): Promise<AgentWorkspaceValidation> {
  let document: ExperimentSourceDocument
  try {
    document = createCadSourceDocument(
      'experiment',
      createExperimentSourceBundle(stagedBundle.files, stagedBundle.geometrySnapshot),
    )
  } catch (cause: unknown) {
    return {
      status: 'invalid',
      sourceHash: null,
      catalogFingerprint: null,
      varsSchemaFingerprint: null,
      sceneHash: null,
      taskSceneHashes: Object.freeze({}),
      diagnostics: Object.freeze([]),
      error: { kind: 'structural', message: (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000) },
    }
  }

  let fallbackSourceHash: string | null = null
  try {
    fallbackSourceHash = await cadSourceHash(document)
  } catch {
    // The compiler will return a bounded structural diagnostic below.
  }

  let catalog
  try {
    catalog = await abortable(fetchCatalogRuntimeSlice(document.sourceBundle), options.signal)
  } catch (cause: unknown) {
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    return {
      status: 'unavailable',
      sourceHash: fallbackSourceHash,
      catalogFingerprint: null,
      varsSchemaFingerprint: null,
      sceneHash: null,
      taskSceneHashes: Object.freeze({}),
      diagnostics: Object.freeze([]),
      error: {
        kind: aborted ? 'cancelled' : 'catalog',
        message: (cause instanceof Error ? cause.message : 'Catalog를 불러오지 못했습니다.').slice(0, 4_000),
      },
    }
  }

  try {
    const inspection = await inspectDocument(document, { catalog, ...options })
    const fingerprint = varsSchemaFingerprint(inspection.varsSchema)
    const fingerprintHash = await sha256(fingerprint)
    const candidateKey = `${runId}:${fingerprintHash}`
    const cached = candidateCache.get(candidateKey)
    const variables = cached ?? generateRandomVars(inspection.varsSchema)
    if (!cached) candidateCache.set(candidateKey, variables)
    const snapshot = await evaluateDocument({ document, vars: variables }, { catalog, ...options })
    return {
      status: 'valid',
      sourceHash: snapshot.sourceHash,
      catalogFingerprint: catalog.catalogRevision,
      varsSchemaFingerprint: fingerprintHash,
      sceneHash: snapshot.scene.sceneHash,
      taskSceneHashes: Object.freeze(
        Object.fromEntries(
          Object.entries(snapshot.taskScenes)
            .slice(0, 64)
            .map(([name, scene]) => [name, scene.sceneHash]),
        ),
      ),
      diagnostics: Object.freeze([]),
      error: null,
    }
  } catch (cause: unknown) {
    const diagnostics =
      cause instanceof CadCompilationError || cause instanceof CadDocumentEvaluationError
        ? Object.freeze(
            cause.diagnostics.slice(0, 20).map((diagnostic) =>
              Object.freeze({
                ...diagnostic,
                message: diagnostic.message.slice(0, 1_000),
              }),
            ),
          )
        : Object.freeze([])
    const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 4_000)
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    const timedOut = /timed out|timeout/iu.test(message)
    return {
      status: aborted ? 'unavailable' : 'invalid',
      sourceHash: fallbackSourceHash,
      catalogFingerprint: catalog.catalogRevision,
      varsSchemaFingerprint: null,
      sceneHash: null,
      taskSceneHashes: Object.freeze({}),
      diagnostics,
      error: {
        kind: aborted
          ? 'cancelled'
          : timedOut
            ? 'timeout'
            : cause instanceof CadCompilationError
              ? cause.errorType === 'compile'
                ? 'type'
                : cause.errorType
              : 'evaluation',
        message,
      },
    }
  }
}
