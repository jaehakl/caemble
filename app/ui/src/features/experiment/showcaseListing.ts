import type { AvailableExperimentsResponse, SavedExperimentRecord } from '@/api'

export type ShowcaseSort =
  'created-desc' | 'created-asc' | 'name-asc' | 'name-desc' | 'measurements-desc' | 'measurements-asc'
export type ExperimentGroup = { identity: string; repository: string; versions: SavedExperimentRecord[] }

export function showcaseGroups(available?: AvailableExperimentsResponse): ExperimentGroup[] {
  const groups = new Map<string, ExperimentGroup>()
  const seen = new Set<number>()
  for (const row of [...(available?.mine ?? []), ...(available?.demos ?? [])]) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const repository = `${row.namespace}/${row.repository_slug}`
    const identity = `${repository}/${row.experiment_key}`
    const group = groups.get(identity) ?? { identity, repository, versions: [] }
    group.versions.push(row)
    groups.set(identity, group)
  }
  for (const group of groups.values()) {
    group.versions.sort(
      (a, b) =>
        b.version_major - a.version_major ||
        b.version_minor - a.version_minor ||
        b.version_patch - a.version_patch ||
        b.id - a.id,
    )
  }
  return [...groups.values()]
}

export function filterShowcase(
  groups: ExperimentGroup[],
  search: string,
  repositories: string[] | null,
  sort: ShowcaseSort,
) {
  const needle = search.trim().toLocaleLowerCase()
  return groups
    .filter((group) => {
      const row = group.versions[0]
      return (
        (repositories === null || repositories.includes(group.repository)) &&
        `${row.name} ${row.description ?? ''} ${row.experiment_key}`.toLocaleLowerCase().includes(needle)
      )
    })
    .sort((a, b) => {
      const left = a.versions[0]
      const right = b.versions[0]
      const direction = sort.endsWith('asc') ? 1 : -1
      let difference: number
      if (sort.startsWith('created')) {
        const l = left.created_at ? Date.parse(left.created_at) : NaN
        const r = right.created_at ? Date.parse(right.created_at) : NaN
        if (Number.isFinite(l) !== Number.isFinite(r)) return Number.isFinite(l) ? -1 : 1
        difference = Number.isFinite(l) ? l - r : 0
      } else if (sort.startsWith('name')) {
        difference = left.name.localeCompare(right.name)
      } else {
        difference = (left.derivedCounts?.measurements ?? 0) - (right.derivedCounts?.measurements ?? 0)
      }
      return difference * direction || a.identity.localeCompare(b.identity)
    })
}
