import type { CatalogRuntimeSlice } from '@/contracts/catalog'
import type { CadScene } from '../cad/evaluation/types'
import { CadModelError } from '../cad/model/errors'
import { assertValidKernelTaskConfig, type KernelTaskConfig, type SimulationProgramManifest } from '../cad/simulation'
import { installCatalogRuntimeSlice } from './runtime'
import { DRAFT_TASK_KERNEL } from './draftTask'

export type CatalogKernelWorld = Readonly<{
  experiment: CadScene
  tasks: Readonly<Record<string, CadScene>>
}>

export function assertCatalogKernelTasks(
  catalog: CatalogRuntimeSlice,
  program: SimulationProgramManifest,
  world?: CatalogKernelWorld,
) {
  installCatalogRuntimeSlice(catalog)
  const draftTaskNames: string[] = []
  Object.entries(program.tasks).forEach(([taskName, task]) => {
    if (task.kernel.name === DRAFT_TASK_KERNEL.name && task.kernel.version === DRAFT_TASK_KERNEL.version) {
      draftTaskNames.push(taskName)
      return
    }
    const solvers = catalog.solvers.filter(
      (solver) => solver.name === task.kernel.name && solver.version === task.kernel.version,
    )
    if (solvers.length !== 1) {
      throw new CadModelError(
        `Task ${JSON.stringify(taskName)} requires exactly one ${task.kernel.name}@${task.kernel.version} descriptor from its runtime catalog slice.`,
      )
    }
    const taskScene = world?.tasks[taskName]
    if (world && !taskScene) throw new CadModelError(`Task ${JSON.stringify(taskName)} has no evaluated scene.`)
    assertValidKernelTaskConfig(
      solvers[0].descriptor,
      task.config as KernelTaskConfig,
      world ? { scenes: { experiment: world.experiment, task: taskScene! } } : undefined,
    )
  })
  return Object.freeze(draftTaskNames)
}
