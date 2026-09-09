import type { AvailableExperimentsResponse, SavedExperimentRecord } from '@/api'
import type { CatalogExperimentListItem } from '@/api/catalog'

type ManagedExperimentVersion =
  | Readonly<{
      kind: 'example'
      coordinate: string
      description: string
      experimentKey: string
      identity: string
      name: string
      namespace: string
      repository: string
      version: string
      versionParts: readonly [number, number, number]
      item: CatalogExperimentListItem
    }>
  | Readonly<{
      kind: 'saved'
      coordinate: string
      description: string
      experimentKey: string
      identity: string
      name: string
      namespace: string
      repository: string
      version: string
      versionParts: readonly [number, number, number]
      row: SavedExperimentRecord
    }>

export function experimentManagerListing(
  available: AvailableExperimentsResponse | undefined,
  catalogExamples: readonly CatalogExperimentListItem[] = [],
) {
  const mineNamespaces = [...new Set((available?.mine ?? []).map((row) => row.namespace))].sort()
  const demoNamespaces = [...new Set((available?.demos ?? []).map((row) => row.namespace))]
    .filter((namespace) => !mineNamespaces.includes(namespace))
    .sort()
  const namespaces = [...mineNamespaces, ...demoNamespaces]
  const tabs = [
    ...namespaces.map((namespace) => ({ value: `namespace:${namespace}`, label: namespace })),
    { value: 'example', label: '예제' },
  ]
  const examples = catalogExamples.map((item): ManagedExperimentVersion => {
    const versionParts = item.version.split('.').map(Number) as [number, number, number]
    return {
      kind: 'example',
      coordinate: item.coordinate,
      description: item.description || '설명 없음',
      experimentKey: item.key,
      identity: `${item.namespace}/${item.repository}/${item.key}`,
      name: item.title,
      namespace: item.namespace,
      repository: item.repository,
      version: item.version,
      versionParts,
      item,
    }
  })
  const mine = available?.mine ?? []
  const mineIds = new Set(mine.map((row) => row.id))
  const saved = [...mine, ...(available?.demos ?? []).filter((row) => !mineIds.has(row.id))].map(
    (row): ManagedExperimentVersion => {
      const version = row.version ?? `${row.version_major}.${row.version_minor}.${row.version_patch}`
      const identity = `${row.namespace}/${row.repository_slug}/${row.experiment_key}`
      return {
        kind: 'saved',
        coordinate: row.coordinate ?? `caemble:experiment/${identity}@${version}`,
        description: row.description || '설명 없음',
        experimentKey: row.experiment_key,
        identity,
        name: row.name,
        namespace: row.namespace,
        repository: row.repository_slug,
        version,
        versionParts: [row.version_major, row.version_minor, row.version_patch],
        row,
      }
    },
  )
  const versions = [...saved, ...examples].sort(
    (left, right) =>
      (left.kind === right.kind ? 0 : left.kind === 'saved' ? -1 : 1) ||
      (left.kind === 'saved' && right.kind === 'saved'
        ? namespaces.indexOf(left.namespace) - namespaces.indexOf(right.namespace)
        : 0) ||
      left.identity.localeCompare(right.identity) ||
      right.versionParts[0] - left.versionParts[0] ||
      right.versionParts[1] - left.versionParts[1] ||
      right.versionParts[2] - left.versionParts[2] ||
      left.coordinate.localeCompare(right.coordinate),
  )
  return { tabs, versions }
}
