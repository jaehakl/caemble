import { SimulationKernelError } from '../../errors'
import type { KernelDefinition } from '../../kernelContract'
import { dcCurrentDensityDescriptor, type DcCurrentDensityTaskConfig } from './descriptor'
import { executeDcCurrentDensity } from './execute'
import { prepareDcCurrentDensity, type PreparedDcInput } from './prepare'

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
