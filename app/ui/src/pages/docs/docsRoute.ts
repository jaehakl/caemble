export const docsSectionIds = [
  'workbench',
  'structure',
  'program',
  'reference',
  'troubleshooting',
  'geometry',
  'materials',
  'quantity-kinds',
  'solvers',
] as const

export type DocsSectionId = (typeof docsSectionIds)[number]

export const defaultDocsSection: DocsSectionId = 'program'

export function docsSectionHref(section: DocsSectionId, item?: string, anchor?: string) {
  const params = new URLSearchParams({ section })
  if (item) params.set('item', item)
  return `/docs?${params.toString()}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
}
