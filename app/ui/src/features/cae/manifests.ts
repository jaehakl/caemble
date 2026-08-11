import { assertValidKernelDescriptor, type KernelDescriptor } from '@/lib/cad/simulation'

const manifestModules = import.meta.glob('../../../../slaves/cae/app/solvers/*/manifest.json', {
  eager: true,
  import: 'default',
})

export const caeSolverManifestsQueryKey = ['cae', 'solver-manifests'] as const

export type CaeSolverManifest = Readonly<{
  schemaVersion: 1
  implementation: string
  descriptor: KernelDescriptor
}>

export class CaeManifestError extends Error {
  constructor(
    readonly code: 'invalid_manifest',
    message: string,
  ) {
    super(message)
    this.name = 'CaeManifestError'
  }
}

export async function fetchCaeSolverManifests(): Promise<readonly CaeSolverManifest[]> {
  const manifests = Object.entries(manifestModules).map(([path, value]) => {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'implementation', 'descriptor']) ||
      value.schemaVersion !== 1 ||
      typeof value.implementation !== 'string' ||
      !value.implementation ||
      !isRecord(value.descriptor)
    ) {
      throw new CaeManifestError('invalid_manifest', `${path}: solver manifest 구조가 올바르지 않습니다.`)
    }
    try {
      assertValidKernelDescriptor(value.descriptor as KernelDescriptor)
    } catch (error) {
      throw new CaeManifestError(
        'invalid_manifest',
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      implementation: value.implementation,
      descriptor: Object.freeze(value.descriptor) as KernelDescriptor,
    })
  })
  manifests.sort((left, right) =>
    `${left.descriptor.name}@${left.descriptor.version}`.localeCompare(
      `${right.descriptor.name}@${right.descriptor.version}`,
    ),
  )
  const identities = manifests.map(({ descriptor }) => `${descriptor.name}@${descriptor.version}`)
  if (new Set(identities).size !== identities.length) {
    throw new CaeManifestError('invalid_manifest', 'CAE solver manifest identity가 중복되었습니다.')
  }
  return Object.freeze(manifests)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
