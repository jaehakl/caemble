import {
  catalogDocsKnowledge,
  manualDocsKnowledge,
  searchDocsKnowledge,
  type DocsKnowledgeChunk,
} from './docsKnowledge'

export type DocsSearchEntry = DocsKnowledgeChunk

export const manualSearchEntries = manualDocsKnowledge
export const staticCatalogSearchEntries = catalogDocsKnowledge
export { searchDocsKnowledge }
