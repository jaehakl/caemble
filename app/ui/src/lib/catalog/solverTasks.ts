import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { SimulationProgramManifest } from '../cad/simulation'
import { installCatalogRuntimeSlice } from './runtime'
import { DRAFT_TASK_KERNEL } from './draftTask'

export function catalogDraftTaskNames(catalog: CatalogRuntimeSlice, program: SimulationProgramManifest) {
  installCatalogRuntimeSlice(catalog)
  return Object.freeze(
    Object.entries(program.tasks)
      .filter(([, task]) => task.kernel.name === DRAFT_TASK_KERNEL.name && task.kernel.version === DRAFT_TASK_KERNEL.version)
      .map(([taskName]) => taskName),
  )
}
