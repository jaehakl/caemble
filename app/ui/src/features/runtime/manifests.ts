const manifestModules = import.meta.glob('../../../../slaves/*/manifest.json', {
  eager: true,
  import: 'default',
})

export type BundledSlaveManifest = Readonly<Record<string, unknown>> & {
  readonly id: string
  readonly name: string
  readonly module: string
  readonly startup_timeout_seconds?: number
}

function validateSlaveManifest(path: string, value: unknown): BundledSlaveManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object.`)
  }
  const manifest = value as Record<string, unknown>
  for (const field of ['id', 'name', 'module'] as const) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      throw new Error(`${path}.${field} must be a non-empty string.`)
    }
  }
  const timeout = manifest.startup_timeout_seconds
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) {
    throw new Error(`${path}.startup_timeout_seconds must be a positive number.`)
  }
  return Object.freeze(manifest) as BundledSlaveManifest
}

const manifests = Object.entries(manifestModules)
  .map(([path, value]) => validateSlaveManifest(path, value))
  .sort((left, right) => left.id.localeCompare(right.id))

for (let index = 1; index < manifests.length; index += 1) {
  if (manifests[index - 1].id === manifests[index].id) {
    throw new Error(`Duplicate bundled slave manifest id: ${manifests[index].id}`)
  }
}

export const bundledSlaveManifests = Object.freeze(manifests)
