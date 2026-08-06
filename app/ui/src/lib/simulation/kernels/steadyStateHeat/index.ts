import { defineKernelTask } from '../../authoring'
import { SimulationKernelError } from '../../errors'
import type { KernelDefinition } from '../../kernelContract'
import type { DefinedKernelTask } from '../../types'
import {
  steadyStateHeatDescriptor,
  type SteadyStateHeatArtifactTypes,
  type SteadyStateHeatTaskConfig,
} from './descriptor'
import { executeSteadyStateHeat } from './execute'
import { prepareSteadyStateHeat, type PreparedSteadyStateHeatInput } from './prepare'

export {
  steadyStateHeatDescriptor,
  type SteadyStateHeatArtifactTypes,
  type SteadyStateHeatBoundaryCondition,
  type SteadyStateHeatInitialization,
  type SteadyStateHeatOutputRequest,
  type SteadyStateHeatTaskConfig,
} from './descriptor'
export { executeSteadyStateHeat } from './execute'
export { prepareSteadyStateHeat, type PreparedSteadyStateHeatInput } from './prepare'

export const steadyStateHeatKernelRef = Object.freeze({
  name: steadyStateHeatDescriptor.name,
  version: steadyStateHeatDescriptor.version,
})

export function steadyStateHeat<const Config extends SteadyStateHeatTaskConfig>(
  config: Config,
): DefinedKernelTask<
  Config,
  SteadyStateHeatArtifactTypes<Config>,
  Readonly<{ iterations: number; relativeResidual: number }>,
  Readonly<{ heatSource: 'caemble.dc/joule-heating@1' | undefined }>
> {
  return defineKernelTask<
    Config,
    SteadyStateHeatArtifactTypes<Config>,
    Readonly<{ iterations: number; relativeResidual: number }>,
    Readonly<{ heatSource: 'caemble.dc/joule-heating@1' | undefined }>
  >(steadyStateHeatKernelRef, config)
}

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
