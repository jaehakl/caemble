import { cadAuthoringContract, cadElementCatalog } from '@/lib/cad'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import { searchDocsKnowledge, type DocsKnowledgeChunk } from '@/pages/docs/docsKnowledge'

export const CAD_GRAMMAR_CORE_MAX_BYTES = 5 * 1024
export const CAD_GRAMMAR_API_VERSION = cadAuthoringContract.apiVersion

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const catalogTags = cadElementCatalog.map(({ tag }) => tag)

function byteLength(value: string) {
  return encoder.encode(value).byteLength
}

function truncateUtf8(value: string, maxBytes: number) {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1
  return decoder.decode(bytes.slice(0, end))
}

function mentionedTags(value: string) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  return catalogTags.filter((tag) => {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').toLocaleLowerCase()
    return new RegExp(`(^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, 'u').test(normalized)
  })
}

function sourceTags(source: string) {
  const found = new Set<string>()
  for (const match of source.matchAll(/<\s*([a-z][A-Za-z0-9]*)\b/gu)) {
    if (catalogTags.includes(match[1] as (typeof catalogTags)[number])) found.add(match[1])
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

const grammarCore = [
  `# Official CAD authoring grammar — API v${CAD_GRAMMAR_API_VERSION}`,
  'Authority: app-owned Caemble contract. Detailed manuals: /docs?section=reference and /docs?section=geometry.',
  '',
  '## Complete geometry.tsx skeleton',
  '```tsx',
  ...geometryAuthoringSkeletonCode.trim().split('\n'),
  '```',
  '',
  '## Required rules',
  `- New code uses only canonical v${CAD_GRAMMAR_API_VERSION} transforms: ${cadAuthoringContract.transforms.canonicalProperties.map(({ name, type }) => `\`${name}?: ${type}\``).join(', ')}. ${cadAuthoringContract.transforms.rotationConvention} Effective order: ${cadAuthoringContract.transforms.applicationOrder.join(', ')}.`,
  `- Never generate \`translation\`. ${cadAuthoringContract.transforms.legacyProperties.map(({ name }) => `\`${name}\``).join(' and ')} are deprecated v7 compatibility properties for legacy source; do not emit them. ${cadAuthoringContract.transforms.mixing}`,
  `- Every Geometry component call requires a sibling-unique \`id\`. ${cadAuthoringContract.identity.description} Fragment has no \`id\`; example nested path: \`${cadAuthoringContract.identity.pathExample}\`.`,
  '- A topology-changing operation owns its result `id`; consumed operand IDs are not final solver targets. `array` keeps `$cell-x-y-z` instance identity.',
  '- Components inherit the parent Material role map when `materials` is omitted; an explicit map replaces it and `{}` clears it. Primitives consume the `body` role.',
  "- Boolean child order matters: `subtract` uses the first child as base and the rest as cutters. Follow each operation's child contract exactly.",
  '- Import public types and APIs from `@caemble/core`. In `geometry.tsx`, export PascalCase named `Geometry<Props>` components; do not default-export a geometry component.',
  '',
  '## Intrinsic tag index (canonical syntax)',
  ...cadElementCatalog.map(
    ({ category, summary, syntax, tag }) => `- \`${tag}\` (${category}): ${summary} Syntax: \`${syntax}\``,
  ),
].join('\n')

if (byteLength(grammarCore) > CAD_GRAMMAR_CORE_MAX_BYTES) {
  throw new Error(`Official CAD grammar core exceeds ${CAD_GRAMMAR_CORE_MAX_BYTES} UTF-8 bytes.`)
}

export const CAD_GRAMMAR_CORE = grammarCore

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
