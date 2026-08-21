import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { CatalogExperimentDetail, CatalogGeometryDetail } from '@/api/catalog'
import { assertExperimentSourceBundle, type ExperimentSourceBundle } from '@/lib/cad'

export const officialGeometryKeys = [
  'basketball-goal',
  'fiber-bundle',
  'shell-cutaways',
  'random-curved-edge-cylinder-array',
  'random-curved-surface-sphere-hcp-array',
  'geometry-authoring-skeleton',
  'two-material-wheel-assembly',
] as const

export const officialExperimentKeys = [
  'dc-uniform-bar',
  'dc-notched-current-density',
  'dc-resolution-study',
  'electro-thermal-uniform-bar',
] as const

const cached = new Map<string, unknown>()

function catalogQuery(resource: 'geometry' | 'experiment', key: string) {
  const cacheKey = `${resource}:${key}`
  if (cached.has(cacheKey)) return cached.get(cacheKey)
  const catalogRoot = path.resolve(process.cwd(), '../catalog')
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(
    executable,
    [
      '-m',
      'caemble_catalog',
      '--database',
      path.join(catalogRoot, 'caemble_catalog/catalog.sqlite3'),
      'query',
      resource,
      key,
    ],
    {
      cwd: catalogRoot,
      encoding: 'utf8',
      env: { ...process.env, PYTHONPATH: [catalogRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    },
  )
  const value: unknown = JSON.parse(output)
  cached.set(cacheKey, value)
  return value
}

export function officialGeometry(key: (typeof officialGeometryKeys)[number]) {
  return catalogQuery('geometry', key) as CatalogGeometryDetail
}

export function officialExperiment(key: (typeof officialExperimentKeys)[number]) {
  const value = catalogQuery('experiment', key) as CatalogExperimentDetail
  assertExperimentSourceBundle(value.sourceBundle)
  return value as CatalogExperimentDetail & { sourceBundle: ExperimentSourceBundle }
}
