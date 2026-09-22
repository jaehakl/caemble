import { documentationAnchorRedirects } from './anchorRedirects'
import { helpHref } from './helpNavigation'
import { publicDocuments } from './public'
import type { DocumentPage } from './types'

export function resolveDocumentAnchor(item: string, anchor: string | null) {
  return (anchor && documentationAnchorRedirects[item]?.[anchor]) || { item, anchor }
}

/** Render real browser URLs so opening a Markdown link in a new tab also works. */
export function documentationLink(href: string, document: DocumentPage) {
  if (/^(?:[a-z]+:|\/)/i.test(href)) return href
  const url = new URL(href, `https://documentation.invalid/${document.sourcePath}`)
  const page = publicDocuments.find((candidate) => `/${candidate.sourcePath}` === decodeURIComponent(url.pathname))
  if (!page) return href
  const target = resolveDocumentAnchor(page.id, decodeURIComponent(url.hash.slice(1)) || null)
  return helpHref('manual', target.item, target.anchor)
}
