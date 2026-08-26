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

const manifests = Object.entries(manifestModules)
  .map(([, value]) => Object.freeze(value as BundledSlaveManifest))
  .sort((left, right) => left.id.localeCompare(right.id))

export const bundledSlaveManifests = Object.freeze(manifests)
