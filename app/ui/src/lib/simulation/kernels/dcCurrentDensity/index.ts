import { defineKernelTask } from '../../authoring'
import { SimulationKernelError } from '../../errors'
import type { KernelDefinition } from '../../kernelContract'
import type { DefinedKernelTask } from '../../types'
import { dcCurrentDensityDescriptor, type DcArtifactTypes, type DcCurrentDensityTaskConfig } from './descriptor'
import { executeDcCurrentDensity } from './execute'
import { prepareDcCurrentDensity, type PreparedDcInput } from './prepare'

export {
  dcCurrentDensityDescriptor,
  type DcArtifactTypes,
  type DcCurrentDensityBoundaryCondition,
  type DcCurrentDensityInitialization,
  type DcCurrentDensityOutputRequest,
  type DcCurrentDensityTaskConfig,
} from './descriptor'
export { executeDcCurrentDensity } from './execute'
export { prepareDcCurrentDensity, type PreparedDcInput, type ResolvedSurface } from './prepare'

export const dcCurrentDensityKernelRef = Object.freeze({
  name: dcCurrentDensityDescriptor.name,
  version: dcCurrentDensityDescriptor.version,
})

export function dcCurrentDensity<const Config extends DcCurrentDensityTaskConfig>(
  config: Config,
): DefinedKernelTask<
  Config,
  DcArtifactTypes<Config>,
  Readonly<{ iterations: number; relativeResidual: number }>,
  Readonly<Record<string, never>>
> {
  return defineKernelTask<
    Config,
    DcArtifactTypes<Config>,
    Readonly<{ iterations: number; relativeResidual: number }>,
    Readonly<Record<string, never>>
  >(dcCurrentDensityKernelRef, config)
}

export const dcCurrentDensityKernel = Object.freeze({
  descriptor: dcCurrentDensityDescriptor,
  prepare(context) {
    try {
      return prepareDcCurrentDensity(context)
    } catch (error) {
      if (error instanceof SimulationKernelError) throw error
      throw new SimulationKernelError(
        'input',
        dcCurrentDensityDescriptor,
        error instanceof Error ? error.message : String(error),
      )
    }
  },
  execute: executeDcCurrentDensity,
}) satisfies KernelDefinition<PreparedDcInput, DcCurrentDensityTaskConfig>
