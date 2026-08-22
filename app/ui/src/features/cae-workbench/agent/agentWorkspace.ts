import type { ExperimentSourceDocument } from '@/lib/cad'

async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function agentExperimentContextVersion(document: ExperimentSourceDocument) {
  return sha256(
    JSON.stringify({
      files: Object.fromEntries(
        Object.entries(document.sourceBundle.files).sort(([left], [right]) => left.localeCompare(right)),
      ),
    }),
  )
}
