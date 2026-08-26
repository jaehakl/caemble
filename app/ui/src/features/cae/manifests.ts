import { catalogApi } from '@/api/catalog'
import type { KernelDescriptor } from '@/lib/cad/simulation'

export const caeSolverManifestsQueryKey = ['catalog', 'solver-manifests'] as const

export type CaeSolverManifest = Readonly<{
  descriptor: KernelDescriptor
}>

/** @deprecated New code should use catalogApi.listSolvers/getSolver directly. */
export async function fetchCaeSolverManifests(): Promise<readonly CaeSolverManifest[]> {
  const list = await catalogApi.listSolvers({ limit: 100 })
  const details = await Promise.all(list.items.map(({ name, version }) => catalogApi.getSolver(name, version)))
  return Object.freeze(details.map(({ descriptor }) => Object.freeze({ descriptor })))
}
