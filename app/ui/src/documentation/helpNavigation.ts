import { publicDocuments } from './public'

import { helpKindIds, type HelpKindId } from './types'
export { helpKindIds, type HelpKindId } from './types'

export function helpHref(kind: HelpKindId, item?: string | null, anchor?: string | null) {
  const params = new URLSearchParams({ help: kind })
  if (item) params.set('item', item)
  if (anchor) params.set('anchor', anchor)
  return `/workbench?${params}`
}

/** Resolve old public addresses without keeping a second documentation UI. */
export function legacyDocsHref(search: string, hash: string) {
  const params = new URLSearchParams(search)
  const section = params.get('section') ?? 'program'
  let anchor = hash.slice(1)
  try {
    anchor = decodeURIComponent(anchor)
  } catch {
    /* Keep malformed links readable. */
  }
  const item = params.get('item')
  if (section === 'solvers' && item?.startsWith('experiment:')) return helpHref('examples', item.slice(11))
  if (helpKindIds.includes(section as HelpKindId) && section !== 'manual') {
    return helpHref(section as HelpKindId, item, anchor)
  }
  const documents = publicDocuments.filter((page) => page.section === section)
  const page = documents.find((page) => page.anchor === anchor || page.aliases?.includes(anchor))
  if (page) return helpHref('manual', page.id)
  if (anchor) return helpHref('manual', anchor)
  return documents[0] ? helpHref('manual', documents[0].id) : helpHref('home')
}

export function readHelpLocation(search: string) {
  const params = new URLSearchParams(search)
  const kind = params.get('help')
  if (kind === null) return null
  return {
    kind: helpKindIds.includes(kind as HelpKindId) ? (kind as HelpKindId) : ('home' as const),
    item: params.get('item'),
    anchor: params.get('anchor'),
  }
}
