import { cadAuthoringContract, cadElementCatalog } from '@/lib/cad'
import { geometryAuthoringSkeletonCode } from '@/lib/examples'
import { searchDocsKnowledge, type DocsKnowledgeChunk } from '@/pages/docs/docsKnowledge'

export const CAD_GRAMMAR_CORE_MAX_BYTES = 5 * 1024
export const CAD_GRAMMAR_API_VERSION = cadAuthoringContract.apiVersion

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

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

const grammarCore = [
  `# Official CAD authoring grammar — API v${CAD_GRAMMAR_API_VERSION}`,
  'Authority: Caemble app contract. Manuals: /docs?section=reference and /docs?section=geometry.',
  '',
  '## Complete geometry.tsx skeleton',
  '```tsx',
  ...geometryAuthoringSkeletonCode.trim().split('\n'),
  '```',
  '',
  '## Required rules',
  `- New code uses only canonical v${CAD_GRAMMAR_API_VERSION} transforms: ${cadAuthoringContract.transforms.canonicalProperties.map(({ name, type }) => `\`${name}?: ${type}\``).join(', ')}. ${cadAuthoringContract.transforms.rotationConvention} Effective order: ${cadAuthoringContract.transforms.applicationOrder.join(', ')}.`,
  '- Group transforms with lowercase `<translate offset={Vec3}>`, `<rotate axis={Vec3} angle={radians(degrees)}>`, and `<scale x={sx} y={sy} z={sz}>`; wrappers reject direct transform props.',
  `- Never generate \`translation\`. ${cadAuthoringContract.transforms.legacyProperties.map(({ name }) => `\`${name}\``).join(' and ')} and lowercase primitive JSX are deprecated compatibility syntax; do not emit them. ${cadAuthoringContract.transforms.mixing}`,
  '- Omitted component/primitive IDs use lower-kebab names plus `-2`, `-3`; use explicit stable IDs for durable targets. Fragment has no `id`.',
  '- A topology-changing operation owns its result `id`; consumed operand IDs are not final solver targets. `array` keeps `$cell-x-y-z` instance identity.',
  '- Components inherit the parent Material role map when `materials` is omitted; an explicit map replaces it and `{}` clears it. Primitives consume the `body` role.',
  "- Boolean child order matters: `subtract` uses the first child as base and the rest as cutters. Follow each operation's child contract exactly.",
  '- Import PascalCase primitives and public APIs from `@caemble/core`; keep operation tags lowercase. Export PascalCase named `Geometry<Props>` components, never a default Geometry export.',
  '- Local `Geometry<Props>` functions use direct destructuring with an initializer for every custom prop; no `props.foo`, rest, computed, or nested patterns.',
  '- Primitive props are optional; omitted/`undefined` uses Catalog defaults. Operation props and child contracts stay required.',
  '- Bounded deterministic `for`, `map`, and `if` are supported. Use explicit loop IDs; prefer `array` for regular lattices.',
  '',
  '## Element index (canonical syntax)',
  ...cadElementCatalog.map(
    ({ authoringName, category, summary, syntax }) =>
      `- \`${authoringName}\` (${category}): ${summary} Syntax: \`${syntax}\``,
  ),
].join('\n')

if (byteLength(grammarCore) > CAD_GRAMMAR_CORE_MAX_BYTES) {
  throw new Error(
    `Official CAD grammar core is ${byteLength(grammarCore)} UTF-8 bytes and exceeds ${CAD_GRAMMAR_CORE_MAX_BYTES}.`,
  )
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
