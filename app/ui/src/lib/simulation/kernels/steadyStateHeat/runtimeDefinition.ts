import { SimulationKernelError } from '../../errors'
import type { KernelDefinition } from '../../kernelContract'
import { steadyStateHeatDescriptor, type SteadyStateHeatTaskConfig } from './descriptor'
import { executeSteadyStateHeat } from './execute'
import { prepareSteadyStateHeat, type PreparedSteadyStateHeatInput } from './prepare'

export const steadyStateHeatKernel = Object.freeze({
  descriptor: steadyStateHeatDescriptor,
  prepare(context) {
    try {
      return prepareSteadyStateHeat(context)
    } catch (error) {
      if (error instanceof SimulationKernelError) throw error
      throw new SimulationKernelError(
        'input',
        steadyStateHeatDescriptor,
        error instanceof Error ? error.message : String(error),
      )
    }
  },
  execute: executeSteadyStateHeat,
}) satisfies KernelDefinition<PreparedSteadyStateHeatInput, SteadyStateHeatTaskConfig>
