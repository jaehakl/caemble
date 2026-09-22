import { documentationAnchorRedirects } from './anchorRedirects'
import { helpHref } from './helpNavigation'
import { publicDocuments } from './public'
import type { DocumentPage } from './types'

/** Render real browser URLs so opening a Markdown link in a new tab also works. */
export function documentationLink(href: string, document: DocumentPage) {
  if (/^(?:[a-z]+:|\/)/i.test(href)) return href
  const url = new URL(href, `https://documentation.invalid/${document.sourcePath}`)
  const page = publicDocuments.find((candidate) => `/${candidate.sourcePath}` === decodeURIComponent(url.pathname))
  if (!page) return href
  const anchor = decodeURIComponent(url.hash.slice(1)) || null
  const target = (anchor && documentationAnchorRedirects[page.id]?.[anchor]) || { item: page.id, anchor }
  return helpHref('manual', target.item, target.anchor)
}
