import { CAD_API_DECLARATION_FINGERPRINT, cadAuthoringContract, cadElementCatalog } from '@/lib/cad'
import { buildCadAuthoringReference, CAD_GRAMMAR_CORE_MAX_BYTES } from '@/lib/cad/authoringReference'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import { searchDocsKnowledge, type DocsKnowledgeChunk } from '@/pages/docs/docsKnowledge'

export { CAD_GRAMMAR_CORE_MAX_BYTES }

export const CAD_AUTHORING_REFERENCE = buildCadAuthoringReference({
  authoringContract: cadAuthoringContract,
  declarationFingerprint: CAD_API_DECLARATION_FINGERPRINT,
  elements: cadElementCatalog,
  geometrySkeleton: geometryAuthoringSkeletonCode,
})
export const CAD_GRAMMAR_API_VERSION = CAD_AUTHORING_REFERENCE.apiVersion
export const CAD_GRAMMAR_CORE = CAD_AUTHORING_REFERENCE.core

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.slice(0, end))
}

function mentionedTags(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  return cadElementCatalog
    .filter(({ authoringName, tag }) =>
      [authoringName, tag].some((name) => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').toLocaleLowerCase()
        return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'u').test(normalized)
      }),
    )
    .map(({ tag }) => tag)
}

function sourceTags(source: string) {
  const found = new Set<string>()
  for (const match of source.matchAll(/<\s*([A-Za-z][A-Za-z0-9]*)\b/gu)) {
    const entry = cadElementCatalog.find(({ authoringName, tag }) => match[1] === authoringName || match[1] === tag)
    if (entry) found.add(entry.tag)
  }
  return [...found]
}

function geometryChunk(tag: string, chunks: readonly DocsKnowledgeChunk[]) {
  return chunks.find((chunk) => chunk.id === `geometry:${tag}`)
}

function uniqueChunks(chunks: readonly (DocsKnowledgeChunk | undefined)[], limit: number) {
  const ids = new Set<string>()
  const result: DocsKnowledgeChunk[] = []
  for (const chunk of chunks) {
    if (!chunk || ids.has(chunk.id)) continue
    ids.add(chunk.id)
    result.push(chunk)
    if (result.length >= limit) break
  }
  return result
}

export function cadReferenceSearchHints(activeSource: string, diagnostics: string) {
  return truncateUtf8([sourceTags(activeSource).join(' '), diagnostics].filter(Boolean).join('\n'), 8 * 1024)
}

export function selectAiReferenceDocs({
  activeSource,
  diagnostics,
  docsKnowledge,
  limit,
  prompt,
  recentUserPrompts,
}: Readonly<{
  activeSource: string
  diagnostics: string
  docsKnowledge: readonly DocsKnowledgeChunk[]
  limit: number
  prompt: string
  recentUserPrompts: readonly string[]
}>) {
  const conversation = [prompt, ...recentUserPrompts.slice(-2)].join('\n')
  const explicit = mentionedTags(conversation)
  const active = sourceTags(activeSource)
  const diagnosticTags = mentionedTags(diagnostics)
  const signalQuery = cadReferenceSearchHints(activeSource, diagnostics)

  return uniqueChunks(
    [
      ...explicit.map((tag) => geometryChunk(tag, docsKnowledge)),
      ...active.map((tag) => geometryChunk(tag, docsKnowledge)),
      ...diagnosticTags.map((tag) => geometryChunk(tag, docsKnowledge)),
      ...searchDocsKnowledge(conversation, docsKnowledge),
      ...searchDocsKnowledge(signalQuery, docsKnowledge),
    ],
    limit,
  )
}
