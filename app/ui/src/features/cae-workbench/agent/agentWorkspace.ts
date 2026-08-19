import {
  canonicalizeGeometrySnapshot,
  type ExperimentSourceDocument,
  type GeometryDraftOverlay,
} from '@/lib/cad'

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
