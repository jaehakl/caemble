import type { CatalogSearchItem } from '@/api/catalog'
import { cadElementCatalog } from '@/lib/cad/catalog'
import { publicDocuments } from '@/documentation/public'
import { docsSectionHref, type DocsSectionId } from './docsRoute'

export type DocsKnowledgeChunk = Readonly<{
  aliases?: readonly string[]
  anchor?: string
  collapsed?: boolean
  content: string
  href: string
  id: string
  item?: string
  keywords: readonly string[]
  section: DocsSectionId
  summary: string
  title: string
}>

export const manualDocsKnowledge: readonly DocsKnowledgeChunk[] = publicDocuments.map((document) => ({
  ...document,
  section: document.section!,
  keywords: document.keywords,
  href: docsSectionHref(document.section!, undefined, document.anchor),
}))

export const catalogDocsKnowledge: readonly DocsKnowledgeChunk[] = Object.freeze([
  ...cadElementCatalog.map((entry) =>
    Object.freeze({
      id: `geometry:${entry.tag}`,
      section: 'geometry' as const,
      title: entry.authoringName,
      summary: entry.summary,
      item: entry.tag,
      href: docsSectionHref('geometry', entry.tag),
      keywords: Object.freeze([
        entry.authoringName,
        entry.tag,
        entry.category,
        entry.syntax,
        ...entry.keywords,
        ...entry.properties.flatMap(({ name, type }) => [name, type]),
      ]),
      content: [
        `Authoring name: ${entry.authoringName}`,
        `Registry tag: ${entry.tag}`,
        `Category: ${entry.category}`,
        `Syntax: ${entry.syntax}`,
        `Summary: ${entry.summary}`,
        `Origin: ${entry.origin}`,
        `Children (${entry.children.count}): ${entry.children.description}`,
        '',
        'Properties:',
        ...entry.properties.map(
          (property) =>
            `- ${property.name}: ${property.type}; ${property.required ? 'required' : 'optional'}${'default' in property && property.default !== undefined ? `; default ${property.default}` : ''}. ${property.description}`,
        ),
        '',
        'Surfaces:',
        ...(entry.surfaces.length
          ? entry.surfaces.map((surface) => `- \`surface/${surface.index}\` — ${surface.label}: ${surface.description}`)
          : ['- No fixed surface contract.']),
        '',
        '검증된 부분 TSX 예시 — 완성 파일이 아닌 단일 element 식:',
        '```tsx',
        entry.example,
        '```',
      ].join('\n'),
    }),
  ),
])

export function catalogSearchKnowledge(items: readonly CatalogSearchItem[]): readonly DocsKnowledgeChunk[] {
  return Object.freeze(
    items.map((item) => {
      const section =
        item.kind === 'quantityKind'
          ? 'quantity-kinds'
          : item.kind === 'solver' || item.kind === 'experiment'
            ? 'solvers'
            : 'materials'
      const selectedItem = item.kind === 'experiment' ? `experiment:${item.key}` : item.key
      return Object.freeze({
        id: `${item.kind}:${item.key}`,
        section,
        title: item.title,
        summary: item.subtitle,
        item: selectedItem,
        href: docsSectionHref(section, selectedItem),
        keywords: Object.freeze([item.kind, item.key, item.title, item.subtitle]),
        content: item.subtitle,
      })
    }),
  )
}

export function getDocsKnowledge(): readonly DocsKnowledgeChunk[] {
  return [...manualDocsKnowledge, ...catalogDocsKnowledge]
}

export function searchDocsKnowledge(
  query: string,
  chunks: readonly DocsKnowledgeChunk[] = getDocsKnowledge(),
): readonly DocsKnowledgeChunk[] {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase()
  if (!needle) return []
  const terms = needle.split(/\s+/).filter(Boolean)

  return chunks
    .flatMap((chunk) => {
      const title = chunk.title.normalize('NFKC').toLocaleLowerCase()
      const normalizedKeywords = chunk.keywords.map((keyword) => keyword.normalize('NFKC').toLocaleLowerCase())
      const keywords = normalizedKeywords.join(' ')
      const text = `${title} ${chunk.summary} ${keywords}${chunk.item ? ` ${chunk.content}` : ''}`
        .normalize('NFKC')
        .toLocaleLowerCase()
      const matchedTerms = terms.filter((term) => text.includes(term)).length
      if (!text.includes(needle) && matchedTerms === 0) return []
      const rank =
        title === needle
          ? 0
          : title.startsWith(needle)
            ? 1
            : normalizedKeywords.some((keyword) => keyword === needle)
              ? 2
              : normalizedKeywords.some((keyword) => keyword.startsWith(needle))
                ? 3
                : text.includes(needle)
                  ? 4
                  : 5
      return [{ chunk, matchedTerms, rank }]
    })
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        right.matchedTerms - left.matchedTerms ||
        left.chunk.title.localeCompare(right.chunk.title, 'ko') ||
        left.chunk.id.localeCompare(right.chunk.id),
    )
    .map(({ chunk }) => chunk)
}
