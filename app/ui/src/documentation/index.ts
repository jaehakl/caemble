import { publicDocuments } from './public'
import { developmentDocuments } from './development'

export const documents = [...publicDocuments, ...developmentDocuments]

export function searchDocuments(query: string) {
  const terms = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  return documents.filter((document) => {
    const text =
      `${document.id} ${document.title} ${document.summary} ${document.keywords.join(' ')} ${document.content}`
        .normalize('NFKC')
        .toLocaleLowerCase()
    return terms.every((term) => text.includes(term))
  })
}
