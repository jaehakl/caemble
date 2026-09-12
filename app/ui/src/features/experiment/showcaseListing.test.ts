import { expect, it } from 'vitest'
import type { AvailableExperimentRecord } from '@/api'
import { filterShowcase, showcaseGroups } from './showcaseListing'

export function showcaseRow(id: number, overrides: Partial<AvailableExperimentRecord> = {}): AvailableExperimentRecord {
  return {
    id,
    namespace: 'owner',
    repository_slug: 'repo',
    experiment_key: `key-${id}`,
    name: `Experiment ${id}`,
    version_major: 1,
    version_minor: 0,
    version_patch: 0,
    source_bundle: { files: {} },
    source_hash: 'hash',
    predictionReady: false,
    predictionCounts: { recordedMeasurements: 0, readyCalculations: 0, calculationData: 0 },
    demoOrder: null,
    demoDefault: false,
    ...overrides,
  }
}

it('deduplicates visible IDs and groups only matching full identities by numeric SemVer', () => {
  const old = showcaseRow(1, { experiment_key: 'shared', version_minor: 2 })
  const latest = showcaseRow(2, { experiment_key: 'shared', version_minor: 10 })
  const other = showcaseRow(3, { experiment_key: 'shared', repository_slug: 'other' })
  const groups = showcaseGroups({ mine: [old, latest, other], demos: [latest] })
  expect(groups).toHaveLength(2)
  expect(groups[0].versions.map((row) => row.id)).toEqual([2, 1])
})

it('filters on the representative version and supports multiple repositories', () => {
  const groups = showcaseGroups({
    mine: [
      showcaseRow(1, { name: 'Old title', experiment_key: 'same' }),
      showcaseRow(2, { name: 'New title', experiment_key: 'same', version_minor: 1 }),
      showcaseRow(3, { repository_slug: 'other' }),
    ],
    demos: [],
  })
  expect(filterShowcase(groups, 'Old title', null, 'created-desc')).toHaveLength(0)
  expect(filterShowcase(groups, 'new', ['owner/repo'], 'created-desc')).toHaveLength(1)
  expect(filterShowcase(groups, '', [], 'created-desc')).toHaveLength(0)
  expect(filterShowcase(groups, '', ['owner/repo', 'owner/other'], 'created-desc')).toHaveLength(2)
})

it('sorts all six directions using representative creation time and measurement count', () => {
  const groups = showcaseGroups({
    mine: [
      showcaseRow(1, {
        name: 'B',
        created_at: '2026-01-01',
        derivedCounts: { measurements: 8, recordedData: 0, calculations: 0 },
      }),
      showcaseRow(2, {
        name: 'A',
        created_at: '2026-02-01',
        derivedCounts: { measurements: 2, recordedData: 0, calculations: 0 },
      }),
      showcaseRow(3, { name: 'C' }),
    ],
    demos: [],
  })
  for (const [sort, ids] of [
    ['created-desc', [2, 1, 3]],
    ['created-asc', [1, 2, 3]],
    ['name-asc', [2, 1, 3]],
    ['name-desc', [3, 1, 2]],
    ['measurements-desc', [1, 2, 3]],
    ['measurements-asc', [3, 2, 1]],
  ] as const) {
    expect(filterShowcase(groups, '', null, sort).map((group) => group.versions[0].id)).toEqual(ids)
  }
})
