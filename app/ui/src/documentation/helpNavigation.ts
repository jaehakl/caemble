import { helpKindIds, type HelpKindId } from './types'
export { helpKindIds, type HelpKindId } from './types'

export function helpHref(kind: HelpKindId, item?: string | null, anchor?: string | null) {
  const params = new URLSearchParams({ help: kind })
  if (item) params.set('item', item)
  if (anchor) params.set('anchor', anchor)
  return `/doc?${params}`
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
