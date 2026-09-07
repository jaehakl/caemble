import { authoringGuides } from '@/authoring/guides'
import { manualDocuments } from './manual'
import type { DocumentPage } from './types'

/** Only user-facing documents enter the web manual; Catalog entries remain live. */
export const publicDocuments: readonly DocumentPage[] = [
  ...authoringGuides.map((guide) => ({
    id: `authoring-${guide.id}`,
    section: 'reference' as const,
    anchor: `authoring-${guide.id}`,
    title: guide.title,
    summary: guide.summary,
    keywords: ['CLI', 'external agent', 'authoring', guide.id, ...guide.referenceIds],
    sourcePath: `docs/authoring/${guide.id}.md`,
    content: guide.content,
  })),
  ...manualDocuments,
]
