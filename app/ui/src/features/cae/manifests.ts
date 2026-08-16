import { ZodError } from 'zod'
import { catalogApi } from '@/api/catalog'
import type { KernelDescriptor } from '@/lib/cad/simulation'

export const caeSolverManifestsQueryKey = ['catalog', 'solver-manifests'] as const

export type CaeSolverManifest = Readonly<{
  schemaVersion: 1
  descriptor: KernelDescriptor
  contractDigest?: string
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

/** @deprecated New code should use catalogApi.listSolvers/getSolver directly. */
export async function fetchCaeSolverManifests(): Promise<readonly CaeSolverManifest[]> {
  try {
    const list = await catalogApi.listSolvers({ limit: 100 })
    const details = await Promise.all(list.items.map(({ name, version }) => catalogApi.getSolver(name, version)))
    return Object.freeze(
      details.map(({ contractDigest, descriptor }) =>
        Object.freeze({ schemaVersion: 1 as const, descriptor, contractDigest }),
      ),
    )
  } catch (error) {
    if (error instanceof ZodError) {
      throw new CaeManifestError('invalid_manifest', `Catalog API의 Solver 계약이 올바르지 않습니다: ${error.message}`)
    }
    throw error
  }
}
