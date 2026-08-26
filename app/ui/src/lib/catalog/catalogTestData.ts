import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { CatalogExperimentDetail } from '@/api/catalog'
import { assertExperimentSourceBundle, type ExperimentSourceBundle } from '@/lib/cad'

export const exampleExperimentKeys = [
  'basketball-goal',
  'fiber-bundle',
  'shell-cutaways',
  'random-curved-edge-cylinder-array',
  'random-curved-surface-sphere-hcp-array',
  'geometry-authoring-skeleton',
  'two-material-wheel-assembly',
  'dc-uniform-bar',
  'dc-notched-current-density',
  'dc-resolution-study',
  'electro-thermal-uniform-bar',
] as const

const cached = new Map<string, unknown>()
const exampleExperimentRepositories: Record<(typeof exampleExperimentKeys)[number], string> = {
  'basketball-goal': 'getting-started',
  'fiber-bundle': 'advanced-shapes',
  'shell-cutaways': 'advanced-shapes',
  'random-curved-edge-cylinder-array': 'arrays',
  'random-curved-surface-sphere-hcp-array': 'arrays',
  'geometry-authoring-skeleton': 'getting-started',
  'two-material-wheel-assembly': 'assemblies',
  'dc-uniform-bar': 'verified',
  'dc-notched-current-density': 'verified',
  'dc-resolution-study': 'verified',
  'electro-thermal-uniform-bar': 'verified',
}

export const exampleExperimentVersions: Record<(typeof exampleExperimentKeys)[number], '2.0.0' | '3.0.0'> = {
  'basketball-goal': '2.0.0',
  'fiber-bundle': '2.0.0',
  'shell-cutaways': '2.0.0',
  'random-curved-edge-cylinder-array': '2.0.0',
  'random-curved-surface-sphere-hcp-array': '2.0.0',
  'geometry-authoring-skeleton': '2.0.0',
  'two-material-wheel-assembly': '2.0.0',
  'dc-uniform-bar': '3.0.0',
  'dc-notched-current-density': '3.0.0',
  'dc-resolution-study': '3.0.0',
  'electro-thermal-uniform-bar': '3.0.0',
}

type ExampleVersion = '1.0.0' | '2.0.0' | '3.0.0'

function catalogQuery(key: (typeof exampleExperimentKeys)[number], version: ExampleVersion) {
  const repository = exampleExperimentRepositories[key]
  const cacheKey = `caemble:experiment/caemble/${repository}/${key}@${version}`
  if (cached.has(cacheKey)) return cached.get(cacheKey)
  const catalogRoot = path.resolve(process.cwd(), '../catalog')
  const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  const output = execFileSync(
    executable,
    [
      '-m',
      'caemble_catalog',
      '--database',
      process.env.CAEMBLE_CATALOG_DATABASE ?? path.join(catalogRoot, 'caemble_catalog/catalog.sqlite3'),
      'query',
      'experiment',
      key,
      version,
      '--namespace',
      'caemble',
      '--repository',
      repository,
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

export function exampleExperiment(
  key: (typeof exampleExperimentKeys)[number],
  version: ExampleVersion = exampleExperimentVersions[key],
) {
  const value = catalogQuery(key, version) as CatalogExperimentDetail
  assertExperimentSourceBundle(value.sourceBundle)
  return value as CatalogExperimentDetail & { sourceBundle: ExperimentSourceBundle }
}
